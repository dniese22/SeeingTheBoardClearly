import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
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
# Prefer the ./static folder (index.html, styles.css, app.js live together there).
# Fall back to the project root if index.html is sitting next to main.py.
BASE_DIR = Path(__file__).resolve().parent
static_dir = BASE_DIR / "static"
if not (static_dir / "index.html").exists():
    static_dir = BASE_DIR

if not (static_dir / "index.html").exists():
    raise RuntimeError(
        f"index.html not found in '{BASE_DIR / 'static'}' or '{BASE_DIR}'. "
        f"Put index.html, styles.css and app.js together in a 'static' folder next to main.py."
    )

# Kept so any old /static/... links still work.
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def index():
    return FileResponse(str(static_dir / "index.html"))


# --- Schedule cache ---
# The slider fires a request on every change, so avoid re-downloading the
# full schedule each time. Refreshes once an hour.
_SCHEDULE_TTL_SECONDS = 3600
_schedule_cache = {"loaded_at": 0.0, "df": None}


def _get_schedules() -> pl.DataFrame:
    now = time.time()
    if _schedule_cache["df"] is None or now - _schedule_cache["loaded_at"] > _SCHEDULE_TTL_SECONDS:
        _schedule_cache["df"] = nfl.load_schedules(seasons=True)
        _schedule_cache["loaded_at"] = now
    return _schedule_cache["df"]


# --- Helpers ---
def _compute_team_metrics(schedules: pl.DataFrame, last_n: Optional[int] = None):
    """
    Returns (metrics_df, max_games)

    metrics_df columns:
        season, team, games, win_pct, over_pct, ats_pct, pushes, cover_pct

    last_n: if provided, only each team's most recent `last_n` played games
            (within each season) are used. The most recent game is game #1.
    max_games: the most games any team has played in the data passed in
               (computed BEFORE the last_n window is applied, so it can be
               used as the slider maximum).
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
    # Used to put each team's games in chronological order
    order_cols = [c for c in ("week", "gameday") if c in schedules.columns]

    schedules = schedules.select(required + order_cols)

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
    # Win% logic (HOME result > 0; AWAY result < 0)
    # win_pct = total wins / games played
    # -----------------------------
    df = df.with_columns(
        pl.col("result").cast(pl.Float64, strict=False).alias("result_num")
    )
    df = df.filter(pl.col("result_num").is_not_null())

    order_exprs = [pl.col(c) for c in order_cols]

    home_rows = df.select(
        *order_exprs,
        season=pl.col("season"),
        team=pl.col("home_team"),
        win=(pl.col("result_num") > 0),
        over_game=(pl.col("home_score") + pl.col("away_score") > pl.col("total_line")),
        # Home covers if margin beats the spread; None = push
        ats=pl.when(pl.col("result_num") == pl.col("spread_line"))
        .then(None)
        .otherwise(pl.col("result_num") > pl.col("spread_line")),
    )

    away_rows = df.select(
        *order_exprs,
        season=pl.col("season"),
        team=pl.col("away_team"),
        win=(pl.col("result_num") < 0),
        over_game=(pl.col("home_score") + pl.col("away_score") > pl.col("total_line")),
        # Away covers if home margin is less than the spread; None = push
        ats=pl.when(pl.col("result_num") == pl.col("spread_line"))
        .then(None)
        .otherwise(pl.col("result_num") < pl.col("spread_line")),
    )

    stacked = pl.concat([home_rows, away_rows])

    if stacked.height == 0:
        return stacked, 0

    # --- Order each team's games oldest -> newest, then number them from the
    #     most recent game backwards (most recent = 1) ---
    stacked = (
        stacked.sort(["season", "team"] + order_cols)
        .with_row_index("_row")
        .with_columns(
            games_back=pl.col("_row")
            .rank("ordinal", descending=True)
            .over(["season", "team"])
        )
    )

    # Max games played by any team (full season, before the window is applied)
    max_games = int(
        stacked.group_by(["season", "team"]).len()["len"].max() or 0
    )

    # --- Apply "last N games" window ---
    if last_n is not None and last_n > 0:
        stacked = stacked.filter(pl.col("games_back") <= last_n)

    out = (
        stacked.group_by(["season", "team"])
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").mean(),
            over_pct=pl.col("over_game").mean(),
            ats_pct=pl.col("ats").mean(),  # mean() skips nulls, so pushes are excluded
            pushes=pl.col("ats").is_null().sum(),
        )
        .with_columns(cover_pct=pl.col("ats_pct"))
        .sort(["season", "team"])
    )

    return out, max_games


# --- API ---
@app.get("/api/team_metrics/seasons")
def team_metrics_seasons():
    schedules = _get_schedules()

    if "season" not in schedules.columns:
        return {"status": "error", "message": "No 'season' column in schedules data."}

    seasons = (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )
    return {"status": "ok", "seasons": seasons}


@app.get("/api/team_metrics")
def team_metrics(
    season: int = Query(default=None),
    last_n: int = Query(default=None, ge=1, description="Only use each team's most recent N games"),
):
    schedules = _get_schedules()

    if season is not None:
        schedules = schedules.filter(pl.col("season") == season)

    # If user passes a season that yields nothing, return empty list
    if schedules.height == 0:
        return {
            "status": "ok",
            "season": season,
            "last_n": last_n,
            "max_games": 0,
            "teams": [],
            "message": "No rows found for that season.",
        }

    out, max_games = _compute_team_metrics(schedules, last_n=last_n)

    # Frontend expects flat fields: win_pct, over_pct, ats_pct, cover_pct
    records = out.to_dicts()

    return {
        "status": "ok",
        "season": season,
        "last_n": last_n,
        "max_games": max_games,
        "metric_definitions": {
            "win_pct": "Team win rate (straight up). Home uses result > 0; Away uses result < 0.",
            "over_pct": "Over rate: (home_score + away_score) > total_line",
            "ats_pct": "Against the spread win rate from team perspective (cover the spread)",
            "cover_pct": "ATS cover rate (same as ats_pct in this MVP definition)",
        },
        "teams": records,
    }


# --- Serve the frontend files at the site root ---
# MUST stay below all @app.get(...) API routes so it never shadows them.
# This makes the relative links in index.html (styles.css, app.js) resolve
# to /styles.css and /app.js.
app.mount("/", StaticFiles(directory=str(static_dir)), name="site")


# ---- Optional API verification hook (non-invasive) ----
# Run with:
# VERIFY_API_ON_START=1 API_BASE_URL="http://127.0.0.1:8000" VERIFY_SEASON=2025 uvicorn main:app --host 127.0.0.1 --port 8000
if os.environ.get("VERIFY_API_ON_START", "").lower() in ("1", "true", "yes"):
    try:
        from verify_api import verify_api

        verification = verify_api(
            base_url=os.environ.get("API_BASE_URL", "http://127.0.0.1:8000"),
            season=os.environ.get("VERIFY_SEASON", "2025"),
        )
        print("✅ API verification result:", verification)
    except Exception as e:
        print("❌ API verification failed:", str(e))