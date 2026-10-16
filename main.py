from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import nflreadpy as nfl
import polars as pl
from pathlib import Path

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
static_dir = BASE_DIR / "static"

if not static_dir.exists():
    raise RuntimeError(
        f"Static directory not found: '{static_dir}'. "
        f"Create a folder named 'static' next to main.py."
    )

app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def index():
    return FileResponse(str(static_dir / "index.html"))


# --- Helpers ---
def _compute_team_metrics(schedules: pl.DataFrame) -> pl.DataFrame:
    """
    Returns columns:
      season, team, win_pct, over_pct, ats_pct, cover_pct
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
    schedules = schedules.select(required)

    df = schedules.filter(
        pl.col("home_score").is_not_null()
        & pl.col("away_score").is_not_null()
        & pl.col("spread_line").is_not_null()
        & pl.col("total_line").is_not_null()
        & pl.col("season").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
        & pl.col("result").is_not_null()
    )

    # -----------------------------
    # ✅ Win% logic (YOUR requested definition)
    # - If team is HOME: win when result > 0
    # - If team is AWAY: win when result < 0
    # - win_pct = total wins / games played
    # -----------------------------
    df = df.with_columns(
        pl.col("result").cast(pl.Float64, strict=False).alias("result_num")
    )
    df = df.filter(pl.col("result_num").is_not_null())

    home_rows = df.select(
        season=pl.col("season"),
        team=pl.col("home_team"),
        win=(pl.col("result_num") > 0),
        over_game=(pl.col("home_score") + pl.col("away_score") > pl.col("total_line")),
        ats=(
            (pl.col("home_score") + pl.col("spread_line") > pl.col("away_score"))
        ),
    )

    away_rows = df.select(
        season=pl.col("season"),
        team=pl.col("away_team"),
        win=(pl.col("result_num") < 0),
        over_game=(pl.col("home_score") + pl.col("away_score") > pl.col("total_line")),
        ats=(
            (pl.col("away_score") - pl.col("spread_line") > pl.col("home_score"))
        ),
    )

    stacked = pl.concat([home_rows, away_rows])

    out = (
        stacked.group_by(["season", "team"])
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").mean(),        # mean(bool) == wins/games
            over_pct=pl.col("over_game").mean(),
            ats_pct=pl.col("ats"),#.mean(),
        )
        .with_columns(
            # In this MVP definition, Cover% == ATS%
            cover_pct=pl.col("ats_pct"),
        )
        .sort(["season", "team"])
    )

    return out


# --- API ---
@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    schedules = nfl.load_schedules(seasons=True)
    if "season" not in schedules.columns:
        return {"status": "error", "message": "No 'season' column in schedules data."}

    seasons = (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )
    return {"status": "ok", "seasons": seasons}


@app.get("/api/team_metrics")
def team_metrics(season: int = Query(default=None)):
    schedules = nfl.load_schedules(seasons=True)

    if season is not None:
        schedules = schedules.filter(pl.col("season") == season)

    # If user passes a season that yields nothing, return empty list
    if schedules.height == 0:
        return {
            "status": "ok",
            "season": season,
            "teams": [],
            "message": "No rows found for that season.",
        }

    out = _compute_team_metrics(schedules)

    # Frontend expects flat fields: win_pct, over_pct, ats_pct, cover_pct
    records = out.to_dicts()

    return {
        "status": "ok",
        "season": season,
        "metric_definitions": {
            "win_pct": "Team win rate (straight up). Home uses result > 0; Away uses result < 0.",
            "over_pct": "Over rate: (home_score + away_score) > total_line",
            "ats_pct": "Against the spread win rate from team perspective (cover the spread)",
            "cover_pct": "ATS cover rate (same as ats_pct in this MVP definition)",
        },
        "teams": records,
    }