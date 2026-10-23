"""
data_logic.py

Shared computation logic used by:
  - main.py (optional local FastAPI dev server)
  - export_data.py (static JSON generator for production)
"""

from typing import Optional
import polars as pl


def compute_team_metrics(schedules: pl.DataFrame, last_n: Optional[int] = None):
    """
    Returns (metrics_df, max_games)
    (Identical logic to your original _compute_team_metrics)
    """
    required = [
        "season", "home_team", "away_team", "home_score", "away_score",
        "spread_line", "total_line", "result",
    ]
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
        ats=pl.when(pl.col("result_num") == pl.col("spread_line"))
        .then(None)
        .otherwise(pl.col("result_num") < pl.col("spread_line")),
    )

    stacked = pl.concat([home_rows, away_rows])

    if stacked.height == 0:
        return stacked, 0

    stacked = (
        stacked.sort(["season", "team"] + order_cols)
        .with_row_index("_row")
        .with_columns(
            games_back=pl.col("_row")
            .rank("ordinal", descending=True)
            .over(["season", "team"])
        )
    )

    max_games = int(
        stacked.group_by(["season", "team"]).len()["len"].max() or 0
    )

    if last_n is not None and last_n > 0:
        stacked = stacked.filter(pl.col("games_back") <= last_n)

    out = (
        stacked.group_by(["season", "team"])
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

    return out, max_games