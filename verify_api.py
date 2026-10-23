import json
import os
import time

import requests

METRIC_KEYS = {"win_pct", "over_pct", "ats_pct", "cover_pct"}


def verify_api(base_url: str | None = None, season: str = "2025", timeout_s: int = 10, retries: int = 3) -> dict:
    """Checks /api/team_metrics/seasons and /api/team_metrics?season=... return the expected JSON shape."""
    base_url = base_url or os.environ.get("API_BASE_URL", "http://127.0.0.1:8000")

    def get(path: str):
        for i in range(retries):
            try:
                r = requests.get(f"{base_url}{path}", timeout=timeout_s)
                r.raise_for_status()
                return r.status_code, r.json()
            except Exception as e:
                err = e
                if i < retries - 1:
                    time.sleep(0.5 * (i + 1))
        raise RuntimeError(f"{path} failed after {retries} retries: {err}")

    code, data = get("/api/team_metrics/seasons")
    seasons = data.get("seasons")
    checks = {"seasons": {"http_status": code, "ok": isinstance(seasons, list), "seasons_count": len(seasons or [])}}

    code, data = get(f"/api/team_metrics?season={season}")
    teams = data.get("teams")
    checks["metrics"] = {
        "http_status": code,
        "ok": data.get("status") == "ok" and isinstance(teams, list),
        "teams_count": len(teams or []),
        "has_metric_fields_in_sample": bool(teams) and METRIC_KEYS.issubset(teams[0]),
    }

    return {
        "base_url": base_url,
        "season": season,
        "status": "ok" if all(c["ok"] for c in checks.values()) else "partial",
        "checks": checks,
    }


if __name__ == "__main__":
    print(json.dumps(verify_api(season=os.environ.get("VERIFY_SEASON", "2025")), indent=2))
