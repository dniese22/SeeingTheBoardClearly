import nflreadpy as nfl

CANDIDATES = ["load_schedules", "load_stats", "load_team_stats", "load_pbp"]

def show_loader(name):
    fn = getattr(nfl, name)
    print("\n" + "="*80)
    print("LOADER:", name, "=>", fn)
    try:
        df = fn(seasons=True)
    except TypeError:
        # some loaders may not take seasons=True
        df = fn()
    # If it’s a pandas df already, good. If not, try to coerce.
    try:
        cols = list(df.columns)
    except Exception:
        # last resort
        try:
            pdf = df.to_pandas()
            cols = list(pdf.columns)
        except Exception as e:
            print("Could not read columns:", e)
            return
    print("Column count:", len(cols))
    # show columns that look odds/lines related
    keywords = ["spread", "total", "over", "under", "closing", "line", "odds", "closing_line", "vegas"]
    hits = [c for c in cols if any(k.lower() in str(c).lower() for k in keywords)]
    print("Keyword-matching columns:", hits[:200])
    print("Sample columns:", cols[:40])

if __name__ == "__main__":
    for name in CANDIDATES:
        show_loader(name)