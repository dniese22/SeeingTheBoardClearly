"""
Generates static JSON files under static/data/ that the frontend
reads directly (no backend required in production).

Run manually:
    python export_data.py
"""
import json
from pathlib import Path

import polars as pl

from data_logic import (
    compute_team_metrics,
    get_next_week_games,
    get_seasons,
    load_schedules,
)

REPO_ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = REPO_ROOT / "static" / "data"


def to_payload(out_df: pl.DataFrame, max_games: int) -> dict:
    """Matches exactly what static/app.js expects: { maxGames, rows }."""
    rows = out_df.to_dicts() if max_games > 0 else []
    return {"maxGames": int(max_games), "rows": rows}


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))


def export_full_and_windows(schedules: pl.DataFrame, folder: Path) -> int:
    """
    Writes full.json plus every 1..max_games-1 window file for the given
    schedules slice. Returns max_games so the caller can log it.
    """
    full_out, max_games = compute_team_metrics(schedules, last_n=None)
    write_json(folder / "full.json", to_payload(full_out, max_games))

    # last_n == max_games is identical to "full" (frontend never requests
    # it — effectiveLastN() returns null at the max), so only 1..max-1 needed.
    for last_n in range(1, max_games):
        windowed_out, _ = compute_team_metrics(schedules, last_n=last_n)
        write_json(folder / f"{last_n}.json", to_payload(windowed_out, max_games))

    return max_games


def main() -> None:
    schedules = load_schedules()
    seasons = get_seasons(schedules)

    # /data/seasons.json -> bare array, as fetchSeasons() expects.
    write_json(OUTPUT_DIR / "seasons.json", seasons)
    print(f"seasons.json: {len(seasons)} seasons")

    futures = get_next_week_games(schedules)
    write_json(OUTPUT_DIR / "futures.json", futures)
    print(
        f"futures.json: season={futures['season']}, "
        f"week={futures['week']}, games={len(futures['games'])}"
    )

    # Per-season folders: /data/<season>/full.json, /data/<season>/<n>.json
    for season in seasons:
        season_schedules = schedules.filter(pl.col("season") == season)
        folder = OUTPUT_DIR / str(int(season))
        max_games = export_full_and_windows(season_schedules, folder)
        print(f"season {season}: maxGames={max_games}")

    # /data/all/... : every (season, team) row, unaggregated across seasons,
    # windowed per-season (because _compute_team_metrics groups by
    # [season, team] internally) — matches the "team history" view exactly.
    all_folder = OUTPUT_DIR / "all"
    global_max = export_full_and_windows(schedules, all_folder)
    print(f"all: maxGames={global_max}")


if __name__ == "__main__":
    main()