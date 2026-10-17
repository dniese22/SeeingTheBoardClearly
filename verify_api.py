# verify_api.py
import os
import time
import json
from typing import Optional

import requests


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def verify_api(
    base_url: Optional[str] = None,
    season: str = "2025",
    timeout_s: int = 10,
    retries: int = 3,
) -> dict:
    """
    Verifies backend health by checking:
      - /api/team_metrics/seasons returns JSON with a 'seasons' list
      - /api/team_metrics?season=... returns JSON with:
          status == 'ok' and teams is a list
    """

    if base_url is None:
        base_url = _env("API_BASE_URL", "http://127.0.0.1:8000")

    def attempt(fn, label: str):
        last_err = None
        for i in range(retries):
            try:
                return fn()
            except Exception as e:
                last_err = e
                time.sleep(0.5 * (i + 1))
        raise RuntimeError(f"{label} failed after {retries} retries: {last_err}")

    result = {
        "base_url": base_url,
        "season": season,
        "status": "unknown",
        "checks": {},
    }

    def check_seasons():
        url = f"{base_url}/api/team_metrics/seasons"
        r = requests.get(url, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()

        ok = (
            isinstance(data, dict)
            and isinstance(data.get("seasons"), list)
        )
        return {
            "url": url,
            "http_status": r.status_code,
            "ok": ok,
            "seasons_count": len(data.get("seasons", [])),
        }

    def check_metrics():
        url = f"{base_url}/api/team_metrics?season={season}"
        r = requests.get(url, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()

        ok = (
            isinstance(data, dict)
            and data.get("status") == "ok"
            and isinstance(data.get("teams"), list)
        )
        return {
            "url": url,
            "http_status": r.status_code,
            "ok": ok,
            "teams_count": len(data.get("teams", [])),
            "has_metric_fields_in_sample": (
                bool(data.get("teams"))
                and all(k in data["teams"][0] for k in ("win_pct", "over_pct", "ats_pct", "cover_pct"))
            ),
        }

    result["checks"]["seasons"] = attempt(check_seasons, "seasons endpoint")
    result["checks"]["metrics"] = attempt(check_metrics, "metrics endpoint")

    if result["checks"]["seasons"]["ok"] and result["checks"]["metrics"]["ok"]:
        result["status"] = "ok"
    else:
        result["status"] = "partial"

    return result


if __name__ == "__main__":
    out = verify_api(
        base_url=os.environ.get("API_BASE_URL", "http://127.0.0.1:8000"),
        season=os.environ.get("VERIFY_SEASON", "2025"),
    )
    print(json.dumps(out, indent=2))