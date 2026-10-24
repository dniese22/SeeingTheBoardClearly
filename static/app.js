const statusEl = document.getElementById("status");
const tbody = document.getElementById("metricsTbody");
const headerRow = document.getElementById("metricsHeaderRow");
const tableTitle = document.getElementById("tableTitle");
const percentagesViewButton = document.getElementById("percentagesViewButton");
const futuresViewButton = document.getElementById("futuresViewButton");
const gamesCard = document.getElementById("gamesCard");
const teamControl = document.getElementById("teamControl");
const seasonControl = document.getElementById("seasonControl");
const lowerMarker = document.getElementById("lowerMarker");
const higherMarker = document.getElementById("higherMarker");
const lowerLabel = document.getElementById("lowerLabel");
const higherLabel = document.getElementById("higherLabel");
const segLower = document.getElementById("segLower");
const segMiddle = document.getElementById("segMiddle");
const segHigher = document.getElementById("segHigher");

// NEW: previous-games slider elements
const gamesSlider = document.getElementById("gamesSlider");
const gamesLabel = document.getElementById("gamesLabel");
const gamesMaxLabel = document.getElementById("gamesMaxLabel");
const segGames = document.getElementById("segGames");
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
const columnToggles = document.getElementById("columnToggles");
const showAllColumnsButton = document.getElementById("showAllColumns");
let metrics = [];
let seasons = [];
let selectedTeam = "";
let currentView = "percentages";
let highPercentageFilterEnabled = false;
let requestVersion = 0;

// NEW: previous-games window state
// gamesMax   = most games any team has played (season, or any season in team-history view)
// gamesValue = number of most recent games currently included
// When gamesValue === gamesMax the full season is shown (no last_n sent).
let gamesMax = null;
let gamesValue = null;
let gamesDebounceTimer = null;
const GAMES_DEBOUNCE_MS = 250;

// Cache key: "<season|all>:<lastN|full>" -> { rows, maxGames }
const seasonMetricsCache = new Map();
const columnVisibility = new Map();
const TEAM_KEYS = [
  "team_name",
  "team",
  "Team",
  "abbr",
  "team_abbr",
];
const PREFERRED_METRIC_ORDER = [
  "win_pct",
  "over_pct",
  "ats_pct",
];

// Fields that should never appear in the table or column controls.
const EXCLUDED_METRIC_KEYS = new Set([
  "cover_pct",
  "cover_percent",
  "cover_percentage",
  "games",
  "pushes",
]);

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

function formatColumnLabel(key) {
  const knownLabels = {
    season: "Season",
    team_name: "Team",
    team: "Team",
    Team: "Team",
    abbr: "Team",
    team_abbr: "Team",
    win_pct: "Win%",
    over_pct: "Over%",
    ats_pct: "Cover ATS%",
    cover_pct: "Cover Pct",
    cover_percent: "Cover Pct",
    cover_percentage: "Cover Pct",
    games: "Games",
    pushes: "Pushes",
  };
  if (knownLabels[key]) {
    return knownLabels[key];
  }
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isPercentageColumn(key) {
  return (
    /(?:_pct|_percent|_percentage)$/i.test(key) ||
    key === "win_pct" ||
    key === "over_pct" ||
    key === "ats_pct"
  );
}

function isTeamKey(key) {
  return TEAM_KEYS.includes(key);
}

function isExcludedMetricKey(key) {
  const normalizedKey = String(key)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const label = formatColumnLabel(key).toLowerCase();
  return (
    isTeamKey(key) ||
    key === "season" ||
    key.startsWith("_") ||
    EXCLUDED_METRIC_KEYS.has(normalizedKey) ||
    label === "cover pct" ||
    label === "games" ||
    label === "pushes"
  );
}

// Find all available metric fields across the loaded data.
// Excluded fields are removed before table columns are created.
function getMetricKeys(rows) {
  const keys = new Set();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!isExcludedMetricKey(key)) {
        keys.add(key);
      }
    });
  });
  return [...keys].sort((a, b) => {
    const aIndex = PREFERRED_METRIC_ORDER.indexOf(a);
    const bIndex = PREFERRED_METRIC_ORDER.indexOf(b);
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }
    if (aIndex !== -1) {
      return -1;
    }
    if (bIndex !== -1) {
      return 1;
    }
    return formatColumnLabel(a).localeCompare(formatColumnLabel(b));
  });
}

function getTableColumns() {
  const columns = [];

  if (currentView === "futures") {
    columns.push({ key: "matchup", label: "Matchup", type: "matchup" });
    columns.push(
      { key: "win_pct", label: "Winning Team", type: "team-pick", teamKey: "winning_team" },
      { key: "over_pct", label: formatColumnLabel("over_pct"), type: "percentage" },
      { key: "ats_pct", label: "Covering Team", type: "team-pick", teamKey: "covering_team" }
    );
  } else {
    if (selectedTeam) {
      columns.push({ key: "season", label: "Season", type: "season" });
    }

    // Team is always visible and cannot be toggled off.
    columns.push({ key: "team_name", label: "Team", type: "team" });
  }

  getMetricKeys(metrics)
    .filter(
      (key) =>
        !["matchup", "winning_team", "covering_team"].includes(key) &&
        (currentView !== "futures" ||
          !["win_pct", "over_pct", "ats_pct"].includes(key))
    )
    .forEach((key) => {
      columns.push({
        key,
        label: formatColumnLabel(key),
        type: isPercentageColumn(key) ? "percentage" : "metric",
      });
    });
  return columns;
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
// Previous games slider
// ------------------------------
// Redraw the slider, labels, and filled bar from gamesMax / gamesValue.
function updateGamesUI() {
  if (gamesMax === null || gamesValue === null) {
    gamesSlider.disabled = true;
    gamesLabel.textContent = "—";
    gamesMaxLabel.textContent = "—";
    segGames.style.width = "0%";
    return;
  }
  gamesSlider.disabled = false;

  // Set min/max BEFORE value so the browser doesn't clamp it.
  gamesSlider.min = "1";
  gamesSlider.max = String(gamesMax);
  gamesSlider.value = String(gamesValue);
  gamesLabel.textContent =
    gamesValue === gamesMax ? `All (${gamesMax})` : String(gamesValue);
  gamesMaxLabel.textContent = String(gamesMax);
  const span = gamesMax - 1;
  const percent = span > 0 ? ((gamesValue - 1) / span) * 100 : 100;
  segGames.style.width = `${percent}%`;
}

// Called whenever a new max is learned (season change, team history, startup).
// If the slider was at "All", it stays at "All" for the new max.
// Otherwise the chosen value is kept, clamped to the new max.
function setGamesBounds(newMax) {
  if (!Number.isFinite(newMax) || newMax < 1) {
    gamesMax = null;
    gamesValue = null;
  } else {
    const wasAll =
      gamesMax === null ||
      gamesValue === null ||
      gamesValue >= gamesMax;
    gamesMax = newMax;
    gamesValue = wasAll ? newMax : clamp(gamesValue, 1, newMax);
  }
  updateGamesUI();
}

// The last_n value to send to the API, or null for the full season.
function effectiveLastN() {
  if (gamesMax === null || gamesValue === null) {
    return null;
  }
  return gamesValue < gamesMax ? gamesValue : null;
}

function describeWindow(lastN) {
  if (lastN === null) {
    return "";
  }
  return ` (last ${lastN} game${lastN === 1 ? "" : "s"})`;
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

// ------------------------------
// Static data calls (no backend)
// ------------------------------

async function fetchSeasons() {
  const data = await fetchJSON(`/data/seasons.json`);
  return data;
}

async function fetchMetrics(season, lastN) {
  const key = `${season ?? "all"}:${lastN ?? "full"}`;
  if (seasonMetricsCache.has(key)) {
    return seasonMetricsCache.get(key);
  }
  const seasonPath = season ?? "all";
  const lastNPath = lastN ?? "full";
  const url = `/data/${seasonPath}/${lastNPath}.json`;
  const data = await fetchJSON(url);
  seasonMetricsCache.set(key, data);
  return data;
}

async function fetchFutures() {
  return fetchJSON("/data/futures.json");
}

function buildFuturesMetrics(games, seasonRows) {
  const teamStats = new Map(seasonRows.map((row) => [getTeamName(row), row]));
  const metricKeys = getMetricKeys(seasonRows);

  function leadingTeam(awayTeam, homeTeam, awayValue, homeValue) {
    const awayPercentage = Number(awayValue);
    const homePercentage = Number(homeValue);
    if (
      !Number.isFinite(awayPercentage) ||
      !Number.isFinite(homePercentage) ||
      awayPercentage === homePercentage
    ) {
      return null;
    }

    return awayPercentage > homePercentage
      ? { team: awayTeam, percentage: awayPercentage }
      : { team: homeTeam, percentage: homePercentage };
  }

  return games.map(({ away_team: awayTeam, home_team: homeTeam }) => {
    const awayStats = teamStats.get(awayTeam);
    const homeStats = teamStats.get(homeTeam);
    const matchup = { matchup: `${awayTeam} @ ${homeTeam}` };

    metricKeys.forEach((key) => {
      const awayValue = awayStats?.[key];
      const homeValue = homeStats?.[key];
      const bothValuesAvailable =
        awayValue !== null &&
        awayValue !== undefined &&
        homeValue !== null &&
        homeValue !== undefined &&
        Number.isFinite(Number(awayValue)) &&
        Number.isFinite(Number(homeValue));

      if (key === "win_pct" || key === "ats_pct") {
        const leader = bothValuesAvailable
          ? leadingTeam(awayTeam, homeTeam, awayValue, homeValue)
          : null;
        const recommendationKey =
          key === "win_pct" ? "winning_team" : "covering_team";
        matchup[recommendationKey] = leader?.team ?? null;
        matchup[key] = leader?.percentage ?? null;
        return;
      }

      matchup[key] = bothValuesAvailable
        ? (Number(awayValue) + Number(homeValue)) / 2
        : null;
    });

    return matchup;
  });
}

// ------------------------------
// Dropdown initialization
// ------------------------------

function updateViewUI() {
  const futuresView = currentView === "futures";
  tableTitle.textContent = futuresView
    ? "Betting Futures"
    : "Betting History";
  percentagesViewButton.setAttribute("aria-pressed", String(!futuresView));
  futuresViewButton.setAttribute("aria-pressed", String(futuresView));
  gamesCard.hidden = futuresView;
  teamControl.hidden = futuresView;
  seasonControl.hidden = futuresView;
  seasonSelect.disabled = !futuresView && selectedTeam !== "";
}

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
// Column visibility controls
// ------------------------------

function styleColumnControls() {
  if (!columnToggles) {
    return;
  }
  Object.assign(columnToggles.style, {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
    marginTop: "10px",
  });
  if (showAllColumnsButton) {
    Object.assign(showAllColumnsButton.style, {
      cursor: "pointer",
      padding: "6px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.2)",
      background: "rgba(255,255,255,0.08)",
      color: "inherit",
      fontSize: "12px",
      fontWeight: "600",
    });
  }
}

function renderColumnToggles(columns) {
  if (!columnToggles) {
    return;
  }
  columnToggles.replaceChildren();
  columns.forEach((column) => {
    // Keep the identifying column visible and non-toggleable.
    if (
      column.type === "team" ||
      column.type === "matchup" ||
      column.key === "team_name"
    ) {
      return;
    }

    // Excluded fields are never offered as toggles.
    if (isExcludedMetricKey(column.key)) {
      return;
    }

    // New columns default to visible.
    if (!columnVisibility.has(column.key)) {
      columnVisibility.set(column.key, true);
    }
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");
    checkbox.type = "checkbox";
    checkbox.checked = columnVisibility.get(column.key);
    checkbox.dataset.columnKey = column.key;
    text.textContent = column.label;
    Object.assign(label.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "6px 9px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.16)",
      background: "rgba(255,255,255,0.04)",
      cursor: "pointer",
      fontSize: "12px",
      userSelect: "none",
    });
    checkbox.style.cursor = "pointer";
    checkbox.addEventListener("change", () => {
      columnVisibility.set(column.key, checkbox.checked);
      applyColumnVisibility();
    });
    label.appendChild(checkbox);
    label.appendChild(text);
    columnToggles.appendChild(label);
  });
  styleColumnControls();
}

function applyColumnVisibility() {
  const columns = getTableColumns();
  columns.forEach((column, index) => {

    // Team always remains visible.
    const visible =
      column.type === "team" ||
      column.type === "matchup" ||
      columnVisibility.get(column.key) !== false;
    const header = headerRow.children[index];
    if (header) {
      header.hidden = !visible;
    }
    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      const cell = row.children[index];
      if (cell) {
        cell.hidden = !visible;
      }
    });
  });
}

function showAllColumns() {
  getTableColumns().forEach((column) => {
    columnVisibility.set(column.key, true);
  });
  renderTable();
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

function getDisplayValue(row, column) {
  if (column.type === "season") {
    return String(row.season ?? "—");
  }
  if (column.type === "matchup") {
    return String(row.matchup ?? "—");
  }
  if (column.type === "team-pick") {
    return String(row[column.teamKey] ?? "—");
  }
  if (column.type === "team") {
    return getTeamName(row);
  }
  const value = row[column.key];
  if (column.type === "percentage") {
    return formatPct(value);
  }
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

function renderTable() {
  tbody.replaceChildren();
  headerRow.replaceChildren();
  const columns = getTableColumns();
  const historicalView = selectedTeam !== "";
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    th.dataset.columnKey = column.key;
    headerRow.appendChild(th);
  });
  if (metrics.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columns.length;
    cell.textContent =
      currentView === "futures"
        ? "No upcoming matchups found."
        : historicalView
          ? `No historical statistics found for ${selectedTeam}.`
          : "No statistics available for this season.";
    row.appendChild(cell);
    tbody.appendChild(row);
    renderColumnToggles(columns);
    applyColumnVisibility();
    return;
  }
  metrics.forEach((data) => {
    const row = document.createElement("tr");
    columns.forEach((column) => {
      const value = getDisplayValue(data, column);
      const percentageColumn =
        column.type === "percentage" || column.type === "team-pick";
      const cell = createCell(
        value,
        percentageColumn ? "metric-cell" : ""
      );
      cell.dataset.columnKey = column.key;
      if (percentageColumn) {
        const percentage = getPercentageValue(data[column.key]);
        cell.dataset.metric = column.key;
        cell.dataset.colorable = String(column.type === "percentage");
        cell.dataset.percentage =
          percentage === null ? "" : String(percentage);
        cell.dataset.originalText = value;
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  renderColumnToggles(columns);
  applyPercentageFilter();
  applyColumnVisibility();
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
    const hasQualifyingPercentage = Array.from(cells).some(
      (cell) => {
        if (cell.dataset.percentage === "") {
          return false;
        }
        const value = Number(cell.dataset.percentage);
        return Number.isFinite(value) && value >= higher;
      }
    );

    // If filtering is enabled, hide rows where no percentage
    // reaches the selected Higher Than threshold.
    row.hidden =
      highPercentageFilterEnabled &&
      cells.length > 0 &&
      !hasQualifyingPercentage;
    cells.forEach((cell) => {
      cell.classList.remove(
        "val-red",
        "val-yellow",
        "val-green"
      );
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

      if (cell.dataset.colorable !== "true") {
        return;
      }

      // Apply risk-scale coloring.
      if (value < lower) {
        cell.classList.add("val-red");
      } else if (value > higher) {
        cell.classList.add("val-green");
      } else {
        cell.classList.add("val-yellow");
      }
    });
  });
  applyColumnVisibility();
}

async function loadCurrentView() {
  const version = ++requestVersion;
  const view = currentView;
  const team = view === "percentages" ? selectedTeam : "";
  const season = Number(seasonSelect.value);

  try {
    if (view === "futures") {
      statusEl.textContent = "Loading betting futures...";
      const futures = await fetchFutures();
      if (version !== requestVersion || currentView !== view) {
        return;
      }
      const seasonMetrics = await fetchMetrics(futures.season, null);
      if (version !== requestVersion || currentView !== view) {
        return;
      }

      metrics = buildFuturesMetrics(futures.games, seasonMetrics.rows);
      renderTable();
      statusEl.textContent = metrics.length
        ? `Loaded ${metrics.length} matchups for week ${futures.week} using ${futures.season} statistics.`
        : "No upcoming matchups found.";
      return;
    }

    if (!Number.isFinite(season)) {
      return;
    }

    statusEl.textContent = team
      ? `Loading historical statistics for ${team}...`
      : `Loading metrics for season ${season}...`;
    const full = await fetchMetrics(team ? null : season, null);
    if (
      version !== requestVersion ||
      currentView !== view ||
      selectedTeam !== team
    ) {
      return;
    }
    setGamesBounds(full.maxGames);
    const lastN = effectiveLastN();
    const result =
      lastN === null
        ? full
        : await fetchMetrics(team ? null : season, lastN);
    if (
      version !== requestVersion ||
      currentView !== view ||
      selectedTeam !== team
    ) {
      return;
    }
    metrics = team
      ? result.rows
          .filter((row) => getTeamName(row) === team)
          .sort((a, b) => Number(b.season) - Number(a.season))
      : result.rows;
    renderTable();
    const viewType = team ? "seasons" : "teams";
    statusEl.textContent =
      `Loaded ${metrics.length} ${viewType} for ${team || season}${describeWindow(lastN)}.`;
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
  updateViewUI();
  loadCurrentView();
}

function handleViewChange(view) {
  if (currentView === view) {
    return;
  }
  currentView = view;
  updateViewUI();
  loadCurrentView();
}

function handleRiskChange() {
  updateRiskUI(
    Number(lowerMarker.value),
    Number(higherMarker.value)
  );
  applyPercentageFilter();
}

// Update the label immediately, but wait for the slider to settle
// before asking the API for new numbers.
function handleGamesChange() {
  if (gamesMax === null) {
    return;
  }
  gamesValue = clamp(Number(gamesSlider.value), 1, gamesMax);
  updateGamesUI();
  clearTimeout(gamesDebounceTimer);
  gamesDebounceTimer = setTimeout(loadCurrentView, GAMES_DEBOUNCE_MS);
}

function handleToggleChange() {
  highPercentageFilterEnabled = !highPercentageFilterEnabled;
  updateToggleUI();
  applyPercentageFilter();
}
teamSelect.addEventListener("change", handleTeamChange);
seasonSelect.addEventListener("change", loadCurrentView);
percentagesViewButton.addEventListener("click", () => {
  handleViewChange("percentages");
});
futuresViewButton.addEventListener("click", () => {
  handleViewChange("futures");
});
lowerMarker.addEventListener("input", handleRiskChange);
higherMarker.addEventListener("input", handleRiskChange);
gamesSlider.addEventListener("input", handleGamesChange);
highPercentageToggle.addEventListener(
  "click",
  handleToggleChange
);
if (showAllColumnsButton) {
  showAllColumnsButton.addEventListener(
    "click",
    showAllColumns
  );
}

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
    const latest = await fetchMetrics(latestSeason, null);
    populateTeamDropdown(latest.rows);
    selectedTeam = "";
    updateViewUI();
    setGamesBounds(latest.maxGames);
    metrics = latest.rows;
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
updateGamesUI();
updateToggleUI();
styleColumnControls();
init();
