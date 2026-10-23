"""
export_data.py

Generates static JSON files that power the Betting Percentage table,
so Cloudflare Pages can serve everything with zero backend dependency.

Run manually:
    python export_data.py

Run automatically via GitHub Actions — see
.github/workflows/update-data.yml

Output structure (relative to project root):
    static/data/seasons.json
    static/data/<season>/full.json
    static/data/<season>/<last_n>.json   (last_n = 1..max_games)
"""

import json
from pathlib import Path

import nflreadpy as nfl
import polars as pl

from data_logic import compute_team_metrics

OUTPUT_DIR = Path(__file__).resolve().parent / "static" / "data"


def _write_json(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")))


def export_season(schedules: pl.DataFrame, season: int) -> int:
    season_df = schedules.filter(pl.col("season") == season)
    if season_df.height == 0:
        return 0

    # Full-season metrics (also tells us max_games for this season)
    full_out, max_games = compute_team_metrics(season_df, last_n=None)
    _write_json(
        OUTPUT_DIR / str(season) / "full.json",
        {
            "status": "ok",
            "season": season,
            "last_n": None,
            "max_games": max_games,
            "teams": full_out.to_dicts(),
        },
    )

    # One file per last_n window (covers every slider position)
    for last_n in range(1, max_games + 1):
        out, _ = compute_team_metrics(season_df, last_n=last_n)
        _write_json(
            OUTPUT_DIR / str(season) / f"{last_n}.json",
            {
                "status": "ok",
                "season": season,
                "last_n": last_n,
                "max_games": max_games,
                "teams": out.to_dicts(),
            },
        )

    return max_games


def main():
    print("Loading schedules...")
    schedules = nfl.load_schedules(seasons=True)

    seasons = (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )

    seasons_payload = {"status": "ok", "seasons": []}

    for season in seasons:
        print(f"Exporting season {season}...")
        max_games = export_season(schedules, season)
        if max_games > 0:
            seasons_payload["seasons"].append(
                {"season": season, "max_games": max_games}
            )

    _write_json(OUTPUT_DIR / "seasons.json", seasons_payload)
    print(f"✅ Done. Exported {len(seasons_payload['seasons'])} seasons → {OUTPUT_DIR}")


if __name__ == "__main__":
    main()