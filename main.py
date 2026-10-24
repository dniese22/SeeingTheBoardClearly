import time
from functools import lru_cache
from pathlib import Path

import nflreadpy as nfl
import polars as pl
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).resolve().parent / "static"
if not STATIC_DIR.is_dir():
    raise RuntimeError(f"Static directory not found: '{STATIC_DIR}'. Create a 'static' folder next to main.py.")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


# --- Metrics ---

SCHEDULE_COLS = ["season", "home_team", "away_team", "home_score", "away_score", "spread_line", "total_line", "result"]

METRIC_DEFINITIONS = {
    "win_pct": "Team win rate (straight up). Home uses result > 0; Away uses result < 0.",
    "over_pct": "Over rate: (home_score + away_score) > total_line",
    "ats_pct": "Against the spread win rate from team perspective (cover the spread)",
    "cover_pct": "ATS cover rate (same as ats_pct in this MVP definition)",
}


@lru_cache(maxsize=1)
def _team_metrics(_hour: int) -> pl.DataFrame:
    """Per-season, per-team win/over/ATS rates for every season. Cached; `_hour` is the cache key."""
    games = (
        nfl.load_schedules(seasons=True)
        .select(SCHEDULE_COLS)
        .with_columns(pl.col("result").cast(pl.Float64, strict=False))
        .drop_nulls()
    )
    over = pl.col("home_score") + pl.col("away_score") > pl.col("total_line")
    margin = pl.col("result") - pl.col("spread_line")  # >0 home covers, <0 away covers, 0 push
    

    def side(team: str, sign: int) -> pl.DataFrame:  # sign: +1 home, -1 away
        return games.select(
            "season",
            team=pl.col(team),
            win=sign * pl.col("result") > 0,
            over=over,
            ats=pl.when(margin == 0).then(None).otherwise(sign * margin > 0),  # None = push
        )

    return (
        pl.concat([side("home_team", 1), side("away_team", -1)])
        .group_by("season", "team")
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").mean(),
            over_pct=pl.col("over").mean(),
            ats_pct=pl.col("ats").mean(),  # mean() skips nulls, so pushes are excluded
            pushes=pl.col("ats").null_count(),
        )
        .with_columns(cover_pct=pl.col("ats_pct"))
        .sort("season", "team")
    )


def _metrics() -> pl.DataFrame:
    return _team_metrics(int(time.time() // 3600))  # refreshes at most once an hour


# --- API ---

@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    return {"status": "ok", "seasons": _metrics()["season"].unique().sort().to_list()}


@app.get("/api/team_metrics")
def team_metrics(season: int | None = Query(default=None)):
    df = _metrics()
    if season is not None:
        df = df.filter(pl.col("season") == season)
    response = {"status": "ok", "season": season, "metric_definitions": METRIC_DEFINITIONS, "teams": df.to_dicts()}
    if df.is_empty():
        response["message"] = "No rows found for that season."
    return response
