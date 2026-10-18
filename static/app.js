
const statusEl = document.getElementById("status");
const tbody = document.getElementById("metricsTbody");

const lowerMarker = document.getElementById("lowerMarker");
const higherMarker = document.getElementById("higherMarker");

const lowerLabel = document.getElementById("lowerLabel");
const higherLabel = document.getElementById("higherLabel");
const segLower = document.getElementById("segLower");
const segMiddle = document.getElementById("segMiddle");
const segHigher = document.getElementById("segHigher");

const seasonSelect = document.getElementById("seasonSelect");

const highPercentageToggle = document.getElementById(
  "highPercentageToggle"
);
const highPercentageToggleLabel = document.getElementById(
  "highPercentageToggleLabel"
);
const toggleIndicator = highPercentageToggle.querySelector(
  ".toggle-indicator"
);

let metrics = [];
let highPercentageFilterEnabled = false;

const API_BASE = "https://seeingtheboardclearly.com/api";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function updateRiskUI(lowerPct, higherPct) {
  lowerPct = clamp(Number(lowerPct), 0, 100);
  higherPct = clamp(Number(higherPct), 0, 100);

  if (lowerPct > higherPct) {
    [lowerPct, higherPct] = [higherPct, lowerPct];
  }

  lowerMarker.value = String(lowerPct);
  higherMarker.value = String(higherPct);

  lowerLabel.textContent = `${lowerPct}%`;
  higherLabel.textContent = `${higherPct}%`;

  segLower.style.left = "0%";
  segLower.style.width = `${lowerPct}%`;

  segMiddle.style.left = `${lowerPct}%`;
  segMiddle.style.width = `${higherPct - lowerPct}%`;

  segHigher.style.left = `${higherPct}%`;
  segHigher.style.width = `${100 - higherPct}%`;
}

function formatPct(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return "—";
  }

  return `${(n * 100).toFixed(1)}%`;
}

function getPercentageValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  // API percentages are decimals, e.g. 0.65 = 65%.
  return n * 100;
}

function updateToggleUI() {
  highPercentageToggle.setAttribute(
    "aria-pressed",
    String(highPercentageFilterEnabled)
  );

  highPercentageToggleLabel.textContent =
    highPercentageFilterEnabled
      ? "Filter ≥ Higher Than: On"
      : "Filter ≥ Higher Than: Off";

  highPercentageToggle.style.padding = "9px 13px";
  highPercentageToggle.style.borderRadius = "12px";
  highPercentageToggle.style.border =
    "1px solid rgba(255,255,255,0.22)";
  highPercentageToggle.style.color = "#e5efff";
  highPercentageToggle.style.fontWeight = "700";
  highPercentageToggle.style.fontSize = "13px";
  highPercentageToggle.style.cursor = "pointer";
  highPercentageToggle.style.display = "inline-flex";
  highPercentageToggle.style.alignItems = "center";
  highPercentageToggle.style.gap = "8px";
  highPercentageToggle.style.transition = "background 0.2s ease";

  highPercentageToggle.style.background =
    highPercentageFilterEnabled
      ? "rgba(34, 197, 94, 0.25)"
      : "rgba(255,255,255,0.08)";

  toggleIndicator.style.display = "inline-block";
  toggleIndicator.style.width = "9px";
  toggleIndicator.style.height = "9px";
  toggleIndicator.style.borderRadius = "50%";
  toggleIndicator.style.background =
    highPercentageFilterEnabled ? "#4ade80" : "#94a3b8";
}

function applyColoring() {
  const lower = Number(lowerMarker.value);
  const higher = Number(higherMarker.value);

  const rows = tbody.querySelectorAll("tr");

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td.metric-cell");

    // Determine whether at least one percentage in this row
    // meets or exceeds the Higher Than threshold.
    const hasQualifyingPercentage = Array.from(cells).some((cell) => {
      const rawValue = cell.dataset.percentage;

      if (rawValue === "") {
        return false;
      }

      const value = Number(rawValue);

      return Number.isFinite(value) && value >= higher;
    });

    // When filtering is enabled, hide the entire row if none
    // of its percentages qualify.
    row.hidden =
      highPercentageFilterEnabled && !hasQualifyingPercentage;

    cells.forEach((cell) => {
      cell.classList.remove(
        "val-red",
        "val-yellow",
        "val-green"
      );

      const rawValue = cell.dataset.percentage;
      const value = rawValue === "" ? null : Number(rawValue);

      // Restore the original percentage before applying the filter.
      cell.textContent = cell.dataset.originalText;

      if (value === null || !Number.isFinite(value)) {
        cell.textContent = "—";
        return;
      }

      // Hide individual values below the threshold.
      if (highPercentageFilterEnabled && value < higher) {
        cell.textContent = "";
        return;
      }

      // Retain the existing risk-scale colors.
      if (value < lower) {
        cell.classList.add("val-red");
      } else if (value > higher) {
        cell.classList.add("val-green");
      } else {
        cell.classList.add("val-yellow");
      }
    });
  });
}

function renderTable() {
  tbody.replaceChildren();

  metrics.forEach((row) => {
    const team =
      row.team_name ??
      row.team ??
      row.Team ??
      row.abbr ??
      row.team_abbr ??
      "Unknown";

    const tr = document.createElement("tr");

    const teamCell = document.createElement("td");
    teamCell.textContent = team;
    tr.appendChild(teamCell);

    const percentageColumns = [
      ["win_pct", row.win_pct],
      ["over_pct", row.over_pct],
      ["ats_pct", row.ats_pct],
    ];

    percentageColumns.forEach(([metricName, rawValue]) => {
      const cell = document.createElement("td");

      cell.classList.add("metric-cell");
      cell.dataset.metric = metricName;

      const value = getPercentageValue(rawValue);

      cell.dataset.percentage =
        value === null ? "" : String(value);

      cell.dataset.originalText = formatPct(rawValue);
      cell.textContent = cell.dataset.originalText;

      tr.appendChild(cell);
    });

    tbody.appendChild(tr);
  });

  applyColoring();
}

function handleRiskChange() {
  updateRiskUI(lowerMarker.value, higherMarker.value);
  applyColoring();
}

function handleHighPercentageToggle() {
  highPercentageFilterEnabled = !highPercentageFilterEnabled;

  updateToggleUI();
  applyColoring();
}

lowerMarker.addEventListener("input", handleRiskChange);
higherMarker.addEventListener("input", handleRiskChange);

highPercentageToggle.addEventListener(
  "click",
  handleHighPercentageToggle
);

async function fetchSeasons() {
  const res = await fetch(`${API_BASE}/team_metrics/seasons`);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} - ${res.statusText}`);
  }

  const data = await res.json();
  return data.seasons || [];
}

async function fetchMetricsForSeason(season) {
  const url =
    `${API_BASE}/team_metrics?season=${encodeURIComponent(season)}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} - ${res.statusText}`);
  }

  const data = await res.json();

  if (data.status !== "ok") {
    throw new Error(data.message || "API error");
  }

  return data.teams || [];
}

async function loadSeason(season) {
  statusEl.textContent = `Loading metrics for season ${season}...`;

  try {
    metrics = await fetchMetricsForSeason(season);

    statusEl.textContent =
      `Loaded ${metrics.length} teams for ${season}.`;

    renderTable();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Failed: ${err.message}`;
  }
}

async function init() {
  try {
    statusEl.textContent = "Loading seasons...";

    const seasons = await fetchSeasons();

    if (!seasons.length) {
      throw new Error("No seasons returned by API.");
    }

    seasonSelect.replaceChildren();

    seasons.forEach((season) => {
      const option = document.createElement("option");

      option.value = String(season);
      option.textContent = String(season);

      seasonSelect.appendChild(option);
    });

    const sortedSeasons = [...seasons].sort(
      (a, b) => Number(a) - Number(b)
    );

    const initial = String(
      sortedSeasons[sortedSeasons.length - 1]
    );

    seasonSelect.value = initial;

    await loadSeason(initial);

    seasonSelect.addEventListener("change", () => {
      loadSeason(seasonSelect.value);
    });
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Failed: ${err.message}`;
  }
}

updateRiskUI(
  Number(lowerMarker.value),
  Number(higherMarker.value)
);

updateToggleUI();

init();
