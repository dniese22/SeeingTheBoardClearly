"""Load NFL schedules and calculate data for the static site export."""
import nflreadpy as nfl
import polars as pl


def load_schedules() -> pl.DataFrame:
    """Fresh, uncached load — the Action runs once and exits."""
    return nfl.load_schedules(seasons=True)


def get_seasons(schedules: pl.DataFrame) -> list[int]:
    return (
        schedules.select(pl.col("season").drop_nulls().unique().sort())
        .to_series()
        .to_list()
    )


def get_next_week_games(schedules: pl.DataFrame) -> dict:
    """Return the unplayed matchups in the current season's next scheduled week."""
    season = nfl.get_current_season()
    upcoming = schedules.filter(
        (pl.col("season") == season)
        & pl.col("result").is_null()
        & pl.col("week").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
    )

    if upcoming.is_empty():
        return {"season": int(season), "week": None, "games": []}

    week = int(upcoming.select(pl.col("week").min()).item())
    games = upcoming.filter(pl.col("week") == week)
    order_columns = [column for column in ("gameday", "gametime") if column in schedules.columns]
    if order_columns:
        games = games.sort(order_columns)
    games = games.select("away_team", "home_team").to_dicts()
    return {"season": int(season), "week": week, "games": games}


def compute_team_metrics(schedules: pl.DataFrame, last_n: int | None = None):
    """Return per-team season metrics and the maximum games played."""
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
    order_columns = [column for column in ("week", "gameday") if column in schedules.columns]
    games = schedules.select(required + order_columns).filter(
        pl.col("season").is_not_null()
        & pl.col("home_team").is_not_null()
        & pl.col("away_team").is_not_null()
        & pl.col("home_score").is_not_null()
        & pl.col("away_score").is_not_null()
        & pl.col("spread_line").is_not_null()
        & pl.col("total_line").is_not_null()
        & pl.col("result").is_not_null()
    )
    games = games.with_columns(
        pl.col("result").cast(pl.Float64, strict=False).alias("result_num")
    ).filter(pl.col("result_num").is_not_null())

    order_expressions = [pl.col(column) for column in order_columns]
    over_game = pl.col("home_score") + pl.col("away_score") > pl.col("total_line")
    home = games.select(
        *order_expressions,
        season=pl.col("season"),
        team=pl.col("home_team"),
        win=pl.col("result_num") > 0,
        over_game=over_game,
        ats=pl.when(pl.col("result_num") == pl.col("spread_line"))
        .then(None)
        .otherwise(pl.col("result_num") > pl.col("spread_line")),
    )
    away = games.select(
        *order_expressions,
        season=pl.col("season"),
        team=pl.col("away_team"),
        win=pl.col("result_num") < 0,
        over_game=over_game,
        ats=pl.when(pl.col("result_num") == pl.col("spread_line"))
        .then(None)
        .otherwise(pl.col("result_num") < pl.col("spread_line")),
    )
    stacked = pl.concat([home, away])

    if stacked.is_empty():
        return stacked, 0

    sort_columns = ["season", "team"] + order_columns
    stacked = (
        stacked.sort(sort_columns)
        .with_row_index("_row")
        .with_columns(
            pl.col("_row")
            .rank("ordinal", descending=True)
            .over(["season", "team"])
            .alias("games_back")
        )
    )
    max_games = int(stacked.group_by("season", "team").len()["len"].max())

    if last_n is not None and last_n > 0:
        stacked = stacked.filter(pl.col("games_back") <= last_n)

    result = (
        stacked.group_by("season", "team")
        .agg(
            games=pl.len(),
            win_pct=pl.col("win").mean(),
            over_pct=pl.col("over_game").mean(),
            ats_pct=pl.col("ats").mean(),
            pushes=pl.col("ats").is_null().sum(),
        )
        .with_columns(cover_pct=pl.col("ats_pct"))
        .sort("season", "team")
    )
    return result, max_games