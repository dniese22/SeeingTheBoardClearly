import nflreadpy as nfl

print("nflreadpy load_* functions:")
print([x for x in dir(nfl) if x.startswith("load_")])