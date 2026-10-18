
const statusEl = document.getElementById("status");
const tbody = document.getElementById("metricsTbody");
const headerRow = document.getElementById("metricsHeaderRow");

const lowerMarker = document.getElementById("lowerMarker");
const higherMarker = document.getElementById("higherMarker");

const lowerLabel = document.getElementById("lowerLabel");
const higherLabel = document.getElementById("higherLabel");
const segLower = document.getElementById("segLower");
const segMiddle = document.getElementById("segMiddle");
const segHigher = document.getElementById("segHigher");

const teamSelect = document.getElementById("teamSelect");
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

const API_BASE = "https://seeingtheboardclearly.com/api";

let metrics = [];
let seasons = [];
let selectedTeam = "";
let highPercentageFilterEnabled = false;
let requestVersion = 0;

// Cache season results to avoid downloading the same season repeatedly.
const seasonMetricsCache = new Map();

// ------------------------------
// General helpers
// ------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getTeamName(row) {
  return (
    row.team_name ??
    row.team ??
    row.Team ??
    row.abbr ??
    row.team_abbr ??
    "Unknown"
  );
}

function getPercentageValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  // API percentages are decimals: 0.65 = 65%.
  return number * 100;
}

function formatPct(value) {
  const percentage = getPercentageValue(value);

  return percentage === null
    ? "—"
    : `${percentage.toFixed(1)}%`;
}

// ------------------------------
// Risk scale
// ------------------------------

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

// ------------------------------
// Higher Than toggle
// ------------------------------

function updateToggleUI() {
  highPercentageToggle.setAttribute(
    "aria-pressed",
    String(highPercentageFilterEnabled)
  );

  highPercentageToggleLabel.textContent =
    highPercentageFilterEnabled
      ? "Filter ≥ Higher Than: On"
      : "Filter ≥ Higher Than: Off";

  Object.assign(highPercentageToggle.style, {
    padding: "9px 13px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.22)",
    color: "#e5efff",
    fontWeight: "700",
    fontSize: "13px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    transition: "background 0.2s ease",
    background: highPercentageFilterEnabled
      ? "rgba(34,197,94,0.25)"
      : "rgba(255,255,255,0.08)",
  });

  Object.assign(toggleIndicator.style, {
    display: "inline-block",
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    background: highPercentageFilterEnabled
      ? "#4ade80"
      : "#94a3b8",
  });
}

// ------------------------------
// API calls
// ------------------------------

async function fetchJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} - ${response.statusText}`
    );
  }

  return response.json();
}

async function fetchSeasons() {
  const data = await fetchJSON(
    `${API_BASE}/team_metrics/seasons`
  );

  if (data.status && data.status !== "ok") {
    throw new Error(data.message || "Unable to load seasons.");
  }

  return [...new Set(
    (data.seasons || [])
      .map(Number)
      .filter(Number.isFinite)
  )].sort((a, b) => a - b);
}

async function fetchMetricsForSeason(season) {
  if (seasonMetricsCache.has(season)) {
    return seasonMetricsCache.get(season);
  }

  const url =
    `${API_BASE}/team_metrics?season=${encodeURIComponent(season)}`;

  const data = await fetchJSON(url);

  if (data.status !== "ok") {
    throw new Error(
      data.message || `Unable to load season ${season}.`
    );
  }

  const rows = (data.teams || []).map((row) => ({
    ...row,
    season: row.season ?? season,
  }));

  seasonMetricsCache.set(season, rows);

  return rows;
}

// ------------------------------
// Dropdown initialization
// ------------------------------

function populateSeasonDropdown() {
  seasonSelect.replaceChildren();

  seasons.forEach((season) => {
    const option = document.createElement("option");

    option.value = String(season);
    option.textContent = String(season);

    seasonSelect.appendChild(option);
  });

  if (seasons.length) {
    seasonSelect.value = String(seasons[seasons.length - 1]);
  }
}

function populateTeamDropdown(teamRows) {
  teamSelect.replaceChildren();

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All Teams";
  teamSelect.appendChild(allOption);

  const teams = [
    ...new Set(
      teamRows
        .map(getTeamName)
        .filter((name) => name && name !== "Unknown")
    ),
  ].sort((a, b) => a.localeCompare(b));

  teams.forEach((team) => {
    const option = document.createElement("option");

    option.value = team;
    option.textContent = team;

    teamSelect.appendChild(option);
  });
}

// ------------------------------
// Table rendering
// ------------------------------

function createCell(text, className = "") {
  const cell = document.createElement("td");

  if (className) {
    cell.className = className;
  }

  cell.textContent = text;

  return cell;
}

function renderTable() {
  tbody.replaceChildren();
  headerRow.replaceChildren();

  const historicalView = selectedTeam !== "";

  const columns = historicalView
    ? ["Season", "Team", "Win%", "Over%", "Cover ATS%"]
    : ["Team", "Win%", "Over%", "Cover ATS%"];

  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column;
    headerRow.appendChild(th);
  });

  if (metrics.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = columns.length;
    cell.textContent = historicalView
      ? `No historical statistics found for ${selectedTeam}.`
      : "No statistics available for this season.";

    row.appendChild(cell);
    tbody.appendChild(row);

    return;
  }

  metrics.forEach((data) => {
    const row = document.createElement("tr");

    if (historicalView) {
      row.appendChild(
        createCell(String(data.season ?? "—"))
      );
    }

    row.appendChild(createCell(getTeamName(data)));

    const percentageColumns = [
      ["win_pct", data.win_pct],
      ["over_pct", data.over_pct],
      ["ats_pct", data.ats_pct],
    ];

    percentageColumns.forEach(([metricName, rawValue]) => {
      const cell = createCell(
        formatPct(rawValue),
        "metric-cell"
      );

      const percentage = getPercentageValue(rawValue);

      cell.dataset.metric = metricName;
      cell.dataset.percentage =
        percentage === null ? "" : String(percentage);
      cell.dataset.originalText = formatPct(rawValue);

      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });

  applyPercentageFilter();
}

// ------------------------------
// Percentage filtering and coloring
// ------------------------------

function applyPercentageFilter() {
  const lower = Number(lowerMarker.value);
  const higher = Number(higherMarker.value);

  const rows = tbody.querySelectorAll("tr");

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td.metric-cell");

    // Does this row have at least one percentage at or above
    // the current Higher Than threshold?
    const hasQualifyingPercentage = Array.from(cells).some(
      (cell) => {
        if (cell.dataset.percentage === "") {
          return false;
        }

        const value = Number(cell.dataset.percentage);

        return Number.isFinite(value) && value >= higher;
      }
    );

    // If the toggle is on, hide the entire row when no percentage
    // meets the threshold.
    row.hidden =
      highPercentageFilterEnabled &&
      !hasQualifyingPercentage;

    cells.forEach((cell) => {
      cell.classList.remove(
        "val-red",
        "val-yellow",
        "val-green"
      );

      // Restore the original value before applying the filter.
      cell.textContent = cell.dataset.originalText;

      if (cell.dataset.percentage === "") {
        cell.textContent = "—";
        return;
      }

      const value = Number(cell.dataset.percentage);

      if (!Number.isFinite(value)) {
        cell.textContent = "—";
        return;
      }

      // Hide individual percentages below the threshold.
      if (highPercentageFilterEnabled && value < higher) {
        cell.textContent = "";
        return;
      }

      // Preserve the existing risk-scale coloring.
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

// ------------------------------
// Loading all teams for one season
// ------------------------------

async function loadSelectedSeason() {
  const version = ++requestVersion;
  const season = Number(seasonSelect.value);

  if (!Number.isFinite(season)) {
    return;
  }

  try {
    statusEl.textContent =
      `Loading metrics for season ${season}...`;

    const rows = await fetchMetricsForSeason(season);

    // Ignore results from a previous selection.
    if (
      version !== requestVersion ||
      selectedTeam !== ""
    ) {
      return;
    }

    metrics = rows;

    renderTable();

    statusEl.textContent =
      `Loaded ${metrics.length} teams for ${season}.`;
  } catch (error) {
    if (version !== requestVersion) {
      return;
    }

    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

// ------------------------------
// Loading one team's entire history
// ------------------------------

async function loadSelectedTeamHistory() {
  const version = ++requestVersion;
  const team = selectedTeam;

  try {
    statusEl.textContent =
      `Loading historical statistics for ${team}...`;

    // Fetch all available seasons. Cached seasons load immediately.
    const results = await Promise.all(
      seasons.map((season) => fetchMetricsForSeason(season))
    );

    // Ignore results if the selection changed during loading.
    if (
      version !== requestVersion ||
      selectedTeam !== team
    ) {
      return;
    }

    metrics = results
      .flat()
      .filter((row) => getTeamName(row) === team)
      .sort(
        (a, b) => Number(b.season) - Number(a.season)
      );

    renderTable();

    statusEl.textContent =
      `Loaded ${metrics.length} seasons for ${team}.`;
  } catch (error) {
    if (version !== requestVersion) {
      return;
    }

    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

// ------------------------------
// Event handlers
// ------------------------------

function handleTeamChange() {
  selectedTeam = teamSelect.value;

  if (selectedTeam) {
    // A selected team always displays all available seasons.
    seasonSelect.disabled = true;
    loadSelectedTeamHistory();
  } else {
    // All Teams restores the selected single-season view.
    seasonSelect.disabled = false;
    loadSelectedSeason();
  }
}

function handleRiskChange() {
  updateRiskUI(
    Number(lowerMarker.value),
    Number(higherMarker.value)
  );

  // Recalculate both visible cells and visible rows immediately.
  applyPercentageFilter();
}

function handleToggleChange() {
  highPercentageFilterEnabled = !highPercentageFilterEnabled;

  updateToggleUI();
  applyPercentageFilter();
}

teamSelect.addEventListener("change", handleTeamChange);

seasonSelect.addEventListener("change", loadSelectedSeason);

lowerMarker.addEventListener("input", handleRiskChange);
higherMarker.addEventListener("input", handleRiskChange);

highPercentageToggle.addEventListener(
  "click",
  handleToggleChange
);

// ------------------------------
// Application initialization
// ------------------------------

async function init() {
  try {
    statusEl.textContent = "Loading seasons...";

    seasons = await fetchSeasons();

    if (!seasons.length) {
      throw new Error("No seasons returned by the API.");
    }

    populateSeasonDropdown();

    const latestSeason = seasons[seasons.length - 1];

    statusEl.textContent =
      `Loading teams for season ${latestSeason}...`;

    const latestSeasonRows =
      await fetchMetricsForSeason(latestSeason);

    populateTeamDropdown(latestSeasonRows);

    selectedTeam = "";
    seasonSelect.disabled = false;

    metrics = latestSeasonRows;

    renderTable();

    statusEl.textContent =
      `Loaded ${metrics.length} teams for ${latestSeason}.`;
  } catch (error) {
    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

updateRiskUI(
  Number(lowerMarker.value),
  Number(higherMarker.value)
);

updateToggleUI();

init();
