import nflreadpy as nfl

df = nfl.load_schedules(seasons=True)

pdf = df.filter(
    df["away_score"].is_not_null()
    & df["home_score"].is_not_null()
    & df["spread_line"].is_not_null()
    & df["total_line"].is_not_null()
    & df["result"].is_not_null()
)

cols = [
    "game_id","season","week",
    "away_team","home_team",
    "away_score","home_score","result",
    "spread_line","total_line"
]

print(pdf.select(cols).head(15))