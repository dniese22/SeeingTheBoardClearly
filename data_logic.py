"""
Thin wrapper around main.py's calculation logic so export_data.py
never has to duplicate (and risk drifting from) the real rules.
"""
import nflreadpy as nfl
import polars as pl

# Reuse the exact same function the FastAPI app uses.
# Safe to import: main.py has no top-level side effects beyond
# mounting static files and defining routes.
from main import _compute_team_metrics


def load_schedules() -> pl.DataFrame:
    """Fresh, uncached load — the Action runs once and exits."""
    return nfl.load_schedules(seasons=True)


def get_seasons(schedules: pl.DataFrame) -> list[int]:
    return (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )


def compute_team_metrics(schedules: pl.DataFrame, last_n: int | None = None):
    """Returns (out_df, max_games) — identical to the API's behavior."""
    return _compute_team_metrics(schedules, last_n=last_n)