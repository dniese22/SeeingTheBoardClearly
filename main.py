from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import nflreadpy as nfl
import polars as pl

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Seeing The Board Clearly")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if not STATIC_DIR.is_dir():
    raise RuntimeError(f"Expected static assets at: {STATIC_DIR}")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@lru_cache(maxsize=1)
def _load_schedules_cached() -> pl.DataFrame:
    # IMPORTANT: do not pass seasons=True. In Python, True is also integer 1,
    # which can be interpreted as a request for season 1 instead of all seasons.
    data = nfl.load_schedules()
    if not isinstance(data, pl.DataFrame):
        data = pl.DataFrame(data)
    return data


def _load_schedules() -> pl.DataFrame:
    # Return a frame from the cached source; Polars transformations below are non-mutating.
    try:
        return _load_schedules_cached()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to load NFL schedule data: {exc}") from exc


def _compute_team_metrics(schedules: pl.DataFrame, last_n_games: Optional[int] = None) -> pl.DataFrame:
    required = [
        "season", "home_team", "away_team", "home_score", "away_score",
        "spread_line", "total_line", "result"
    ]
    missing = [column for column in required if column not in schedules.columns]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"NFL schedule data is missing required columns: {', '.join(missing)}"
        )

    chronology = [c for c in ("gameday", "game_date", "week", "game_id") if c in schedules.columns]
    df = schedules.filter(
        pl.col("home_score").is_not_null()
        & pl.col("away_score").is_not_null()
        & pl.col("spread_line").is_not_null()
        & pl.col("total_line").is_not_null()
        & pl.col("season").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
        & pl.col("result").is_not_null()
    ).with_columns(pl.col("result").cast(pl.Float64, strict=False).alias("_result_num"))
    df = df.filter(pl.col("_result_num").is_not_null())

    total_points = pl.col("home_score") + pl.col("away_score")
    home_exprs = [
        pl.col("season").alias("season"),
        pl.col("home_team").alias("team"),
        (pl.col("_result_num") > 0).alias("win"),
        (total_points > pl.col("total_line")).alias("over_game"),
        pl.when(pl.col("_result_num") == pl.col("spread_line"))
          .then(None)
          .otherwise(pl.col("_result_num") > pl.col("spread_line"))
          .alias("ats"),
    ]
    away_exprs = [
        pl.col("season").alias("season"),
        pl.col("away_team").alias("team"),
        (pl.col("_result_num") < 0).alias("win"),
        (total_points > pl.col("total_line")).alias("over_game"),
        pl.when(pl.col("_result_num") == pl.col("spread_line"))
          .then(None)
          .otherwise(pl.col("_result_num") < pl.col("spread_line"))
          .alias("ats"),
    ]
    home_exprs += [pl.col(c).alias(c) for c in chronology]
    away_exprs += [pl.col(c).alias(c) for c in chronology]
    team_games = pl.concat([df.select(home_exprs), df.select(away_exprs)], how="vertical_relaxed")

    if last_n_games is not None:
        n = max(1, int(last_n_games))
        # Sort by available date/week identifiers newest-first, independently for each team/season.
        sort_cols = ["season", "team"] + chronology
        descending = [False, False] + [True] * len(chronology)
        if chronology:
            team_games = team_games.sort(sort_cols, descending=descending, nulls_last=True)
        team_games = team_games.with_columns(
            pl.int_range(0, pl.len()).over(["season", "team"]).alias("_game_rank")
        ).filter(pl.col("_game_rank") < n).drop("_game_rank")

    return (
        team_games.group_by(["season", "team"])
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").cast(pl.Float64).mean(),
            over_pct=pl.col("over_game").cast(pl.Float64).mean(),
            ats_pct=pl.col("ats").cast(pl.Float64).mean(),
            pushes=pl.col("ats").is_null().sum(),
        )
        .with_columns(cover_pct=pl.col("ats_pct"))
        .sort(["season", "team"])
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    schedules = _load_schedules()
    if "season" not in schedules.columns:
        raise HTTPException(status_code=500, detail="NFL schedule data has no 'season' column.")
    seasons = (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series().to_list()
    )
    return {"status": "ok", "seasons": seasons}


@app.get("/api/team_metrics")
def team_metrics(
    season: Optional[int] = Query(default=None),
    last_n_games: Optional[int] = Query(default=None, ge=1, le=100),
):
    schedules = _load_schedules()
    if season is not None:
        schedules = schedules.filter(pl.col("season") == season)
    if schedules.height == 0:
        return {
            "status": "ok", "season": season, "last_n_games": last_n_games,
            "teams": [], "message": "No rows found for that season."
        }

    out = _compute_team_metrics(schedules, last_n_games=last_n_games)
    return {
        "status": "ok",
        "season": season,
        "last_n_games": last_n_games,
        "metric_definitions": {
            "win_pct": "Team win rate (straight up).",
            "over_pct": "Over rate: combined points greater than the total line.",
            "ats_pct": "Against-the-spread win rate from the team's perspective; pushes are excluded.",
            "cover_pct": "ATS cover rate (same as ats_pct).",
        },
        "teams": out.to_dicts(),
    }
