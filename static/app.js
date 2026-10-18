
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

const seasonSelect = document.getElementById("seasonSelect");
const teamSelect = document.getElementById("teamSelect");

const API_BASE = "https://seeingtheboardclearly.com/api";

let metrics = [];
let seasons = [];
let selectedTeam = "";
let requestVersion = 0;

// Cache each season after it is retrieved so switching teams
// does not repeatedly download the same season's statistics.
const seasonMetricsCache = new Map();

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
  if (value === null || value === undefined) {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  // The API returns percentages as decimals between 0 and 1.
  return `${(number * 100).toFixed(1)}%`;
}

function applyColoring() {
  const lower = Number(lowerMarker.value);
  const higher = Number(higherMarker.value);

  tbody.querySelectorAll("td.metric-cell").forEach((cell) => {
    cell.classList.remove("val-red", "val-yellow", "val-green");

    const text = (cell.textContent || "").trim();
    const value = Number(text.replace("%", ""));

    if (!Number.isFinite(value)) {
      return;
    }

    if (value < lower) {
      cell.classList.add("val-red");
    } else if (value > higher) {
      cell.classList.add("val-green");
    } else {
      cell.classList.add("val-yellow");
    }
  });
}

function createCell(value, className = "") {
  const cell = document.createElement("td");

  if (className) {
    cell.className = className;
  }

  cell.textContent = value;
  return cell;
}

function renderTable() {
  tbody.replaceChildren();
  headerRow.replaceChildren();

  const historicalView = selectedTeam !== "";

  // Add the Season column only when viewing one team's history.
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

  metrics.forEach((row) => {
    const tr = document.createElement("tr");

    if (historicalView) {
      tr.appendChild(createCell(String(row.season ?? "—")));
    }

    tr.appendChild(createCell(getTeamName(row)));
    tr.appendChild(createCell(formatPct(row.win_pct), "metric-cell"));
    tr.appendChild(createCell(formatPct(row.over_pct), "metric-cell"));
    tr.appendChild(createCell(formatPct(row.ats_pct), "metric-cell"));

    tbody.appendChild(tr);
  });

  applyColoring();
}

async function fetchJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - ${response.statusText}`);
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

  return (data.seasons || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

async function fetchMetricsForSeason(season) {
  if (seasonMetricsCache.has(season)) {
    return seasonMetricsCache.get(season);
  }

  const url =
    `${API_BASE}/team_metrics?season=${encodeURIComponent(season)}`;

  const data = await fetchJSON(url);

  if (data.status !== "ok") {
    throw new Error(data.message || `Unable to load season ${season}.`);
  }

  const rows = (data.teams || []).map((row) => ({
    ...row,
    season: row.season ?? season,
  }));

  seasonMetricsCache.set(season, rows);

  return rows;
}

function populateSeasonDropdown() {
  seasonSelect.replaceChildren();

  seasons.forEach((season) => {
    const option = document.createElement("option");
    option.value = String(season);
    option.textContent = String(season);
    seasonSelect.appendChild(option);
  });

  if (seasons.length > 0) {
    seasonSelect.value = String(seasons[seasons.length - 1]);
  }
}

function populateTeamDropdown(teamRows) {
  teamSelect.replaceChildren();

  const allTeamsOption = document.createElement("option");
  allTeamsOption.value = "";
  allTeamsOption.textContent = "All Teams";
  teamSelect.appendChild(allTeamsOption);

  const teamNames = [
    ...new Set(
      teamRows
        .map(getTeamName)
        .filter((name) => name && name !== "Unknown")
    ),
  ].sort((a, b) => a.localeCompare(b));

  teamNames.forEach((team) => {
    const option = document.createElement("option");
    option.value = team;
    option.textContent = team;
    teamSelect.appendChild(option);
  });
}

async function loadSelectedSeason() {
  const version = ++requestVersion;
  const season = Number(seasonSelect.value);

  if (!Number.isFinite(season)) {
    return;
  }

  try {
    statusEl.textContent = `Loading metrics for season ${season}...`;

    const rows = await fetchMetricsForSeason(season);

    // Ignore stale responses if the user changes selections quickly.
    if (version !== requestVersion || selectedTeam !== "") {
      return;
    }

    metrics = rows;

    statusEl.textContent =
      `Loaded ${metrics.length} teams for ${season}.`;

    renderTable();
  } catch (error) {
    if (version !== requestVersion) {
      return;
    }

    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

async function loadSelectedTeamHistory() {
  const version = ++requestVersion;
  const team = selectedTeam;

  try {
    statusEl.textContent =
      `Loading historical statistics for ${team}...`;

    // Load all available seasons, using cached results when possible.
    const seasonResults = await Promise.all(
      seasons.map((season) => fetchMetricsForSeason(season))
    );

    if (version !== requestVersion || selectedTeam !== team) {
      return;
    }

    metrics = seasonResults
      .flat()
      .filter((row) => getTeamName(row) === team)
      .sort((a, b) => Number(b.season) - Number(a.season));

    statusEl.textContent =
      `Loaded ${metrics.length} seasons for ${team}.`;

    renderTable();
  } catch (error) {
    if (version !== requestVersion) {
      return;
    }

    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

function handleTeamChange() {
  selectedTeam = teamSelect.value;

  if (selectedTeam) {
    // A team selection always shows every available season.
    seasonSelect.disabled = true;
    loadSelectedTeamHistory();
  } else {
    // Restore the original all-teams, single-season view.
    seasonSelect.disabled = false;
    loadSelectedSeason();
  }
}

function handleRiskChange() {
  updateRiskUI(lowerMarker.value, higherMarker.value);
  applyColoring();
}

lowerMarker.addEventListener("input", handleRiskChange);
higherMarker.addEventListener("input", handleRiskChange);

teamSelect.addEventListener("change", handleTeamChange);
seasonSelect.addEventListener("change", loadSelectedSeason);

async function init() {
  try {
    statusEl.textContent = "Loading seasons...";

    seasons = await fetchSeasons();

    if (seasons.length === 0) {
      throw new Error("No seasons returned by the API.");
    }

    populateSeasonDropdown();

    // Use the most recent season to populate the NFL team list.
    const latestSeason = seasons[seasons.length - 1];

    statusEl.textContent =
      `Loading teams for season ${latestSeason}...`;

    const latestSeasonRows =
      await fetchMetricsForSeason(latestSeason);

    populateTeamDropdown(latestSeasonRows);

    selectedTeam = "";
    seasonSelect.disabled = false;

    // Initially preserve the existing behavior: all teams,
    // with the latest season selected.
    metrics = latestSeasonRows;

    statusEl.textContent =
      `Loaded ${metrics.length} teams for ${latestSeason}.`;

    renderTable();
  } catch (error) {
    console.error(error);
    statusEl.textContent = `Failed: ${error.message}`;
  }
}

updateRiskUI(
  Number(lowerMarker.value),
  Number(higherMarker.value)
);

init();
