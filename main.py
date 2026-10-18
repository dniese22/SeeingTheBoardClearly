
from pathlib import Path
import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import nflreadpy as nfl
import polars as pl


app = FastAPI()

# --- Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Static + Frontend ---
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

if not STATIC_DIR.exists():
    raise RuntimeError(
        f"Static directory not found: '{STATIC_DIR}'. "
        "Create a folder named 'static' next to main.py."
    )

app.mount(
    "/static",
    StaticFiles(directory=str(STATIC_DIR)),
    name="static",
)


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# --- Helpers ---

def _compute_team_metrics(
    schedules: pl.DataFrame,
    last_n_games: int | None = None,
) -> tuple[pl.DataFrame, int]:
    """
    Calculate team metrics from each team's most recent games.

    Args:
        schedules: Schedule data for one or more seasons.
        last_n_games:
            Number of most recent games to include per team.
            None means use all available games.

    Returns:
        A tuple containing:
          - The aggregated team metrics DataFrame.
          - The maximum completed-game count for any team
            in the supplied schedule data.

    A game is included in the metric calculations when its scores,
    spread line, total line, result, season, and team names are present.
    """

    required = [
        "season",
        "home_team",
        "away_team",
        "home_score",
        "away_score",
        "spread_line",
        "total_line",
        "result",
    ]

    missing = [column for column in required if column not in schedules.columns]

    if missing:
        raise ValueError(
            "Schedule data is missing required columns: "
            + ", ".join(missing)
        )

    # Optional fields used to determine chronological order.
    optional_order_columns = [
        "gameday",
        "week",
        "game_id",
    ]

    selected_columns = required + [
        column
        for column in optional_order_columns
        if column in schedules.columns and column not in required
    ]

    df = schedules.select(selected_columns)

    # Keep games with all fields required by the existing metrics.
    df = df.filter(
        pl.col("home_score").is_not_null()
        & pl.col("away_score").is_not_null()
        & pl.col("spread_line").is_not_null()
        & pl.col("total_line").is_not_null()
        & pl.col("season").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
        & pl.col("result").is_not_null()
    )

    df = df.with_columns(
        pl.col("result")
        .cast(pl.Float64, strict=False)
        .alias("result_num")
    )

    df = df.filter(pl.col("result_num").is_not_null())

    if df.height == 0:
        return pl.DataFrame(), 0

    # Sort games chronologically before constructing each team's
    # game history. gameday is the primary date field when available.
    chronology_columns = [
        column
        for column in optional_order_columns
        if column in df.columns
    ]

    sort_columns = ["season"] + chronology_columns

    df = df.sort(sort_columns)

    # Build a row for the home team in every game.
    home_expressions = [
        pl.col("season"),
        pl.col("home_team").alias("team"),
        (pl.col("result_num") > 0).alias("win"),
        (
            pl.col("home_score") + pl.col("away_score")
            > pl.col("total_line")
        ).alias("over_game"),
        (
            pl.when(pl.col("result_num") == pl.col("spread_line"))
            .then(None)
            .otherwise(pl.col("result_num") > pl.col("spread_line"))
        ).alias("ats"),
    ]

    # Carry the chronology fields through so each team's appearances
    # can be sorted and truncated independently.
    home_expressions.extend(
        pl.col(column) for column in chronology_columns
    )

    home_rows = df.select(home_expressions)

    # Build a row for the away team in every game.
    away_expressions = [
        pl.col("season"),
        pl.col("away_team").alias("team"),
        (pl.col("result_num") < 0).alias("win"),
        (
            pl.col("home_score") + pl.col("away_score")
            > pl.col("total_line")
        ).alias("over_game"),
        (
            pl.when(pl.col("result_num") == pl.col("spread_line"))
            .then(None)
            .otherwise(pl.col("result_num") < pl.col("spread_line"))
        ).alias("ats"),
    ]

    away_expressions.extend(
        pl.col(column) for column in chronology_columns
    )

    away_rows = df.select(away_expressions)

    # Each row now represents one team's performance in one game.
    stacked = pl.concat([home_rows, away_rows])

    # Sort each team's appearances from oldest to newest.
    team_sort_columns = (
        ["season"] + chronology_columns + ["team"]
    )

    stacked = stacked.sort(team_sort_columns)

    if stacked.height == 0:
        return pl.DataFrame(), 0

    # Calculate the maximum number of eligible games played by any
    # team in the supplied season data, before applying the slider.
    team_game_counts = stacked.group_by(
        ["season", "team"]
    ).agg(
        pl.len().alias("game_count")
    )

    max_games_value = team_game_counts.select(
        pl.col("game_count").max()
    ).item()

    max_games = int(max_games_value or 0)

    # Keep each team's most recent N games independently.
    # A push still counts as a game for this selection, even though
    # it is excluded from the ATS percentage denominator.
    if last_n_games is not None:
        if last_n_games < 1:
            raise ValueError("last_n_games must be at least 1.")

        stacked = (
            stacked
            .group_by(["season", "team"], maintain_order=True)
            .tail(last_n_games)
        )

    # Calculate metrics from the selected games.
    out = (
        stacked
        .group_by(["season", "team"])
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").mean(),
            over_pct=pl.col("over_game").mean(),
            # Null ATS results are pushes and are excluded from mean().
            ats_pct=pl.col("ats").mean(),
            pushes=pl.col("ats").is_null().sum(),
        )
        .with_columns(
            cover_pct=pl.col("ats_pct")
        )
        .sort(["season", "team"])
    )

    return out, max_games


# --- API ---

@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    schedules = nfl.load_schedules(seasons=True)

    if "season" not in schedules.columns:
        return {
            "status": "error",
            "message": "No 'season' column in schedules data.",
        }

    seasons = (
        schedules
        .select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )

    return {
        "status": "ok",
        "seasons": seasons,
    }


@app.get("/api/team_metrics")
def team_metrics(
    season: int | None = Query(default=None),
    last_n_games: int | None = Query(default=None, ge=1),
):
    schedules = nfl.load_schedules(seasons=True)

    if season is not None:
        schedules = schedules.filter(pl.col("season") == season)

    if schedules.height == 0:
        return {
            "status": "ok",
            "season": season,
            "last_n_games": last_n_games,
            "max_games": 0,
            "teams": [],
            "message": "No rows found for that season.",
        }

    out, max_games = _compute_team_metrics(
        schedules,
        last_n_games=last_n_games,
    )

    records = out.to_dicts()

    return {
        "status": "ok",
        "season": season,
        "last_n_games": last_n_games,
        "max_games": max_games,
        "metric_definitions": {
            "win_pct": (
                "Team win rate (straight up), calculated from the "
                "selected recent games."
            ),
            "over_pct": (
                "Over rate: combined score exceeds total_line, "
                "calculated from the selected recent games."
            ),
            "ats_pct": (
                "Against-the-spread cover rate from the team's "
                "perspective, calculated from the selected recent games. "
                "Pushes are excluded from the percentage denominator."
            ),
            "cover_pct": (
                "ATS cover rate; same definition as ats_pct."
            ),
        },
        "teams": records,
    }


# ---- Optional API verification hook ----
# Run with:
#   VERIFY_API_ON_START=1 \
#   API_BASE_URL="http://127.0.0.1:8000" \
#   VERIFY_SEASON=2025 \
#   uvicorn main:app --host 127.0.0.1 --port 8000

if os.environ.get("VERIFY_API_ON_START", "").lower() in (
    "1",
    "true",
    "yes",
):
    try:
        from verify_api import verify_api

        verification = verify_api(
            base_url=os.environ.get(
                "API_BASE_URL",
                "http://127.0.0.1:8000",
            ),
            season=os.environ.get("VERIFY_SEASON", "2025"),
        )

        print("API verification result:", verification)

    except Exception as error:
        print("API verification failed:", str(error))
