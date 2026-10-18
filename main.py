from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import nflreadpy as nfl
import polars as pl

app = FastAPI(title="Seeing The Board Clearly")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if not STATIC_DIR.is_dir():
    raise RuntimeError(f"Static directory not found: {STATIC_DIR}")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _compute_team_metrics(schedules: pl.DataFrame, last_n_games: Optional[int] = None) -> pl.DataFrame:
    """Calculate season metrics from each team's own most recent games."""
    required = ["season", "home_team", "away_team", "home_score", "away_score", "spread_line", "total_line", "result"]
    missing = [column for column in required if column not in schedules.columns]
    if missing:
        raise ValueError(f"Schedule data is missing required columns: {', '.join(missing)}")

    # Keep available chronology fields so each team's games can be ordered newest-first.
    chronology = [c for c in ("gameday", "game_date", "week", "game_id") if c in schedules.columns]
    select_cols = required + [c for c in chronology if c not in required]
    df = schedules.select(select_cols).filter(
        pl.col("home_score").is_not_null()
        & pl.col("away_score").is_not_null()
        & pl.col("spread_line").is_not_null()
        & pl.col("total_line").is_not_null()
        & pl.col("season").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
        & pl.col("result").is_not_null()
    ).with_columns(pl.col("result").cast(pl.Float64, strict=False).alias("result_num"))
    df = df.filter(pl.col("result_num").is_not_null())

    total_points = pl.col("home_score") + pl.col("away_score")
    home = df.select(
        season=pl.col("season"), team=pl.col("home_team"),
        win=(pl.col("result_num") > 0), over_game=(total_points > pl.col("total_line")),
        ats=pl.when(pl.col("result_num") == pl.col("spread_line")).then(None).otherwise(pl.col("result_num") > pl.col("spread_line")),
        **{c: pl.col(c) for c in chronology},
    )
    away = df.select(
        season=pl.col("season"), team=pl.col("away_team"),
        win=(pl.col("result_num") < 0), over_game=(total_points > pl.col("total_line")),
        ats=pl.when(pl.col("result_num") == pl.col("spread_line")).then(None).otherwise(pl.col("result_num") < pl.col("spread_line")),
        **{c: pl.col(c) for c in chronology},
    )
    team_games = pl.concat([home, away], how="vertical_relaxed")

    if last_n_games is not None:
        n = max(1, int(last_n_games))
        # Prefer the game date, then week/game ID when available. NFL schedules
        # normally include gameday and week; fallback ordering remains deterministic.
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
            win_pct=pl.col("win").mean(),
            over_pct=pl.col("over_game").mean(),
            ats_pct=pl.col("ats").mean(),
            pushes=pl.col("ats").is_null().sum(),
        )
        .with_columns(cover_pct=pl.col("ats_pct"))
        .sort(["season", "team"])
    )


def _load_schedules() -> pl.DataFrame:
    return nfl.load_schedules(seasons=True)


@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    schedules = _load_schedules()
    if "season" not in schedules.columns:
        return {"status": "error", "message": "No 'season' column in schedules data."}
    seasons = schedules.select(pl.col("season").drop_nulls().unique().sort()).to_series().to_list()
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
        return {"status": "ok", "season": season, "last_n_games": last_n_games, "teams": [], "message": "No rows found for that season."}
    out = _compute_team_metrics(schedules, last_n_games=last_n_games)
    return {
        "status": "ok", "season": season, "last_n_games": last_n_games,
        "metric_definitions": {
            "win_pct": "Team win rate (straight up). Home uses result > 0; Away uses result < 0.",
            "over_pct": "Over rate: (home_score + away_score) > total_line",
            "ats_pct": "Against-the-spread win rate from the team's perspective; pushes are excluded.",
            "cover_pct": "ATS cover rate (same as ats_pct in this MVP definition).",
        },
        "teams": out.to_dicts(),
    }
