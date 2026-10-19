const $ = (id) => document.getElementById(id);
const statusEl = $("status"), tbody = $("metricsTbody"), headerRow = $("metricsHeaderRow");
const lowerMarker = $("lowerMarker"), higherMarker = $("higherMarker");
const lowerLabel = $("lowerLabel"), higherLabel = $("higherLabel");
const segLower = $("segLower"), segMiddle = $("segMiddle"), segHigher = $("segHigher");
const teamSelect = $("teamSelect"), seasonSelect = $("seasonSelect");
const highPercentageToggle = $("highPercentageToggle"), highPercentageToggleLabel = $("highPercentageToggleLabel");
const toggleIndicator = highPercentageToggle.querySelector(".toggle-indicator");
const columnToggles = $("columnToggles"), showAllColumnsButton = $("showAllColumns");
const recentGamesSlider = $("recentGamesSlider"), recentGamesValue = $("recentGamesValue"), recentGamesMaxLabel = $("recentGamesMaxLabel");
const API_BASE = "/api";

let metrics = [], seasons = [], selectedTeam = "", highPercentageFilterEnabled = false, requestVersion = 0;
let lastSelectedSeason = null;
const seasonMetricsCache = new Map(), columnVisibility = new Map();
const TEAM_KEYS = ["team_name", "team", "Team", "abbr", "team_abbr"];
const PREFERRED_METRIC_ORDER = ["win_pct", "over_pct", "ats_pct"];
const EXCLUDED_METRIC_KEYS = new Set(["cover_pct", "cover_percent", "cover_percentage", "games", "pushes"]);

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function getTeamName(row) { return row.team_name ?? row.team ?? row.Team ?? row.abbr ?? row.team_abbr ?? "Unknown"; }
function getPercentageValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number * 100 : null;
}
function formatPct(value) { const p = getPercentageValue(value); return p === null ? "—" : `${p.toFixed(1)}%`; }
function formatColumnLabel(key) {
  const labels = { season: "Season", team_name: "Team", team: "Team", Team: "Team", abbr: "Team", team_abbr: "Team", win_pct: "Win%", over_pct: "Over%", ats_pct: "Cover ATS%", cover_pct: "Cover Pct", cover_percent: "Cover Pct", cover_percentage: "Cover Pct", games: "Games", pushes: "Pushes" };
  return labels[key] || String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
}
function isPercentageColumn(key) { return /(?:_pct|_percent|_percentage)$/i.test(key) || ["win_pct", "over_pct", "ats_pct"].includes(key); }
function isTeamKey(key) { return TEAM_KEYS.includes(key); }
function isExcludedMetricKey(key) {
  const normalized = String(key).toLowerCase().replace(/[\s-]+/g, "_");
  const label = formatColumnLabel(key).toLowerCase();
  return isTeamKey(key) || key === "season" || key.startsWith("_") || EXCLUDED_METRIC_KEYS.has(normalized) || ["cover pct", "games", "pushes"].includes(label);
}
function getMetricKeys(rows) {
  const keys = new Set();
  rows.forEach(row => Object.keys(row).forEach(key => { if (!isExcludedMetricKey(key)) keys.add(key); }));
  return [...keys].sort((a, b) => {
    const ai = PREFERRED_METRIC_ORDER.indexOf(a), bi = PREFERRED_METRIC_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return formatColumnLabel(a).localeCompare(formatColumnLabel(b));
  });
}
function getTableColumns() {
  const columns = [];
  if (selectedTeam) columns.push({ key: "season", label: "Season", type: "season" });
  columns.push({ key: "team_name", label: "Team", type: "team" });
  getMetricKeys(metrics).forEach(key => columns.push({ key, label: formatColumnLabel(key), type: isPercentageColumn(key) ? "percentage" : "metric" }));
  return columns;
}

function updateRiskUI(lower, higher) {
  lower = clamp(Number(lower), 0, 100); higher = clamp(Number(higher), 0, 100);
  if (lower > higher) [lower, higher] = [higher, lower];
  lowerMarker.value = String(lower); higherMarker.value = String(higher);
  lowerLabel.textContent = `${lower}%`; higherLabel.textContent = `${higher}%`;
  segLower.style.left = "0%"; segLower.style.width = `${lower}%`;
  segMiddle.style.left = `${lower}%`; segMiddle.style.width = `${higher - lower}%`;
  segHigher.style.left = `${higher}%`; segHigher.style.width = `${100 - higher}%`;
}
function updateToggleUI() {
  highPercentageToggle.setAttribute("aria-pressed", String(highPercentageFilterEnabled));
  highPercentageToggleLabel.textContent = highPercentageFilterEnabled ? "Filter ≥ Higher Than: On" : "Filter ≥ Higher Than: Off";
  Object.assign(highPercentageToggle.style, { padding: "9px 13px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.22)", color: "#e5efff", fontWeight: "700", fontSize: "13px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px", transition: "background 0.2s ease", background: highPercentageFilterEnabled ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.08)" });
  Object.assign(toggleIndicator.style, { display: "inline-block", width: "9px", height: "9px", borderRadius: "50%", background: highPercentageFilterEnabled ? "#4ade80" : "#94a3b8" });
}
async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = `${response.status} - ${response.statusText}`;
    try { const body = await response.json(); detail = body.detail || body.message || detail; } catch (_) {}
    throw new Error(detail);
  }
  return response.json();
}
async function fetchSeasons() {
  const data = await fetchJSON(`${API_BASE}/team_metrics/seasons`);
  if (data.status && data.status !== "ok") throw new Error(data.message || "Unable to load seasons.");
  return [...new Set((data.seasons || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}
async function fetchMetricsForSeason(season, n = Number(recentGamesSlider.value)) {
  const key = `${season}:${n}`;
  if (seasonMetricsCache.has(key)) return seasonMetricsCache.get(key);
  const data = await fetchJSON(`${API_BASE}/team_metrics?season=${encodeURIComponent(season)}&last_n_games=${encodeURIComponent(n)}`);
  if (data.status !== "ok") throw new Error(data.message || `Unable to load season ${season}.`);
  const rows = (data.teams || []).map(row => ({ ...row, season: row.season ?? season }));
  seasonMetricsCache.set(key, rows);
  return rows;
}
function populateSeasonDropdown() {
  seasonSelect.replaceChildren();
  seasons.forEach(season => { const option = document.createElement("option"); option.value = String(season); option.textContent = String(season); seasonSelect.appendChild(option); });
  if (seasons.length) seasonSelect.value = String(seasons[seasons.length - 1]);
}
function populateTeamDropdown(rows) {
  const previous = teamSelect.value;
  teamSelect.replaceChildren();
  const all = document.createElement("option"); all.value = ""; all.textContent = "All Teams"; teamSelect.appendChild(all);
  [...new Set(rows.map(getTeamName).filter(name => name && name !== "Unknown"))].sort((a, b) => a.localeCompare(b)).forEach(team => {
    const option = document.createElement("option"); option.value = team; option.textContent = team; teamSelect.appendChild(option);
  });
  if ([...teamSelect.options].some(option => option.value === previous)) teamSelect.value = previous;
}
function styleColumnControls() {
  Object.assign(columnToggles.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "10px" });
  Object.assign(showAllColumnsButton.style, { cursor: "pointer", padding: "6px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "inherit", fontSize: "12px", fontWeight: "600" });
}
function renderColumnToggles(columns) {
  columnToggles.replaceChildren();
  columns.forEach(column => {
    if (column.type === "team" || isExcludedMetricKey(column.key)) return;
    if (!columnVisibility.has(column.key)) columnVisibility.set(column.key, true);
    const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
    checkbox.type = "checkbox"; checkbox.checked = columnVisibility.get(column.key); checkbox.dataset.columnKey = column.key; text.textContent = column.label;
    Object.assign(label.style, { display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 9px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.04)", cursor: "pointer", fontSize: "12px", userSelect: "none" });
    checkbox.addEventListener("change", () => { columnVisibility.set(column.key, checkbox.checked); applyColumnVisibility(); });
    label.append(checkbox, text); columnToggles.appendChild(label);
  });
}
function applyColumnVisibility() {
  const columns = getTableColumns();
  columns.forEach((column, index) => {
    const visible = column.type === "team" || columnVisibility.get(column.key) !== false;
    if (headerRow.children[index]) headerRow.children[index].hidden = !visible;
    tbody.querySelectorAll("tr").forEach(row => { if (row.children[index]) row.children[index].hidden = !visible; });
  });
}
function showAllColumns() { getTableColumns().forEach(column => columnVisibility.set(column.key, true)); renderTable(); }
function createCell(text, className = "") { const cell = document.createElement("td"); if (className) cell.className = className; cell.textContent = text; return cell; }
function getDisplayValue(row, column) {
  if (column.type === "season") return String(row.season ?? "—");
  if (column.type === "team") return getTeamName(row);
  const value = row[column.key];
  if (column.type === "percentage") return formatPct(value);
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
function renderTable() {
  tbody.replaceChildren(); headerRow.replaceChildren();
  const columns = getTableColumns();
  columns.forEach(column => { const th = document.createElement("th"); th.textContent = column.label; th.dataset.columnKey = column.key; headerRow.appendChild(th); });
  if (!metrics.length) {
    const tr = document.createElement("tr"), td = document.createElement("td"); td.colSpan = columns.length; td.textContent = selectedTeam ? `No historical statistics found for ${selectedTeam}.` : "No statistics available for this season."; tr.appendChild(td); tbody.appendChild(tr);
    renderColumnToggles(columns); applyColumnVisibility(); return;
  }
  metrics.forEach(data => {
    const tr = document.createElement("tr");
    columns.forEach(column => {
      const value = getDisplayValue(data, column), td = createCell(value, column.type === "percentage" ? "metric-cell" : "");
      td.dataset.columnKey = column.key;
      if (column.type === "percentage") { const p = getPercentageValue(data[column.key]); td.dataset.metric = column.key; td.dataset.percentage = p === null ? "" : String(p); td.dataset.originalText = value; }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  renderColumnToggles(columns); applyPercentageFilter(); applyColumnVisibility();
}
function applyPercentageFilter() {
  const lower = Number(lowerMarker.value), higher = Number(higherMarker.value);
  tbody.querySelectorAll("tr").forEach(row => {
    const cells = [...row.querySelectorAll("td.metric-cell")];
    const qualifies = cells.some(cell => cell.dataset.percentage !== "" && Number.isFinite(Number(cell.dataset.percentage)) && Number(cell.dataset.percentage) >= higher);
    row.hidden = highPercentageFilterEnabled && cells.length > 0 && !qualifies;
    cells.forEach(cell => {
      cell.classList.remove("val-red", "val-yellow", "val-green"); cell.textContent = cell.dataset.originalText;
      if (cell.dataset.percentage === "") { cell.textContent = "—"; return; }
      const value = Number(cell.dataset.percentage);
      if (!Number.isFinite(value)) { cell.textContent = "—"; return; }
      if (highPercentageFilterEnabled && value < higher) { cell.textContent = ""; return; }
      cell.classList.add(value < lower ? "val-red" : value > higher ? "val-green" : "val-yellow");
    });
  });
  applyColumnVisibility();
}
function updateRecentGamesUI() {
  const n = Number(recentGamesSlider.value);
  recentGamesValue.textContent = String(n);
  recentGamesSlider.setAttribute("aria-valuetext", `${n} games`);
}
async function loadSelectedSeason() {
  const version = ++requestVersion, season = Number(seasonSelect.value);
  if (!Number.isFinite(season)) return;
  lastSelectedSeason = season;
  try {
    statusEl.textContent = `Loading metrics for season ${season}...`;
    const rows = await fetchMetricsForSeason(season);
    if (version !== requestVersion || selectedTeam) return;
    metrics = rows; renderTable(); statusEl.textContent = `Loaded ${metrics.length} teams for ${season} using the most recent ${recentGamesSlider.value} games.`;
  } catch (error) { if (version !== requestVersion) return; console.error(error); statusEl.textContent = `Failed: ${error.message}`; }
}
async function loadSelectedTeamHistory() {
  const version = ++requestVersion, team = selectedTeam, n = Number(recentGamesSlider.value);
  try {
    statusEl.textContent = `Loading historical statistics for ${team}...`;
    const results = await Promise.all(seasons.map(season => fetchMetricsForSeason(season, n)));
    if (version !== requestVersion || selectedTeam !== team) return;
    metrics = results.flat().filter(row => getTeamName(row) === team).sort((a, b) => Number(b.season) - Number(a.season));
    renderTable(); statusEl.textContent = `Loaded ${metrics.length} seasons for ${team}, using up to ${n} games per season.`;
  } catch (error) { if (version !== requestVersion) return; console.error(error); statusEl.textContent = `Failed: ${error.message}`; }
}
function handleTeamChange() {
  selectedTeam = teamSelect.value; seasonSelect.disabled = Boolean(selectedTeam);
  if (selectedTeam) loadSelectedTeamHistory(); else loadSelectedSeason();
}
function handleRiskChange() { updateRiskUI(Number(lowerMarker.value), Number(higherMarker.value)); applyPercentageFilter(); }
function handleRecentGamesChange() {
  updateRecentGamesUI(); seasonMetricsCache.clear();
  if (selectedTeam) loadSelectedTeamHistory(); else loadSelectedSeason();
}
teamSelect.addEventListener("change", handleTeamChange);
seasonSelect.addEventListener("change", loadSelectedSeason);
lowerMarker.addEventListener("input", handleRiskChange); higherMarker.addEventListener("input", handleRiskChange);
highPercentageToggle.addEventListener("click", () => { highPercentageFilterEnabled = !highPercentageFilterEnabled; updateToggleUI(); applyPercentageFilter(); });
showAllColumnsButton.addEventListener("click", showAllColumns);
recentGamesSlider.addEventListener("input", updateRecentGamesUI);
recentGamesSlider.addEventListener("change", handleRecentGamesChange);

async function init() {
  try {
    statusEl.textContent = "Loading seasons...";
    seasons = await fetchSeasons();
    if (!seasons.length) throw new Error("No seasons returned by the API.");
    populateSeasonDropdown();
    const latestSeason = seasons[seasons.length - 1];
    statusEl.textContent = `Loading teams for season ${latestSeason}...`;
    const allRows = await fetchMetricsForSeason(latestSeason, 100);
    const maxGames = Math.max(1, ...allRows.map(row => Number(row.games) || 1));
    recentGamesSlider.max = String(maxGames); recentGamesSlider.value = String(maxGames);
    recentGamesMaxLabel.textContent = `${maxGames} games`;
    updateRecentGamesUI(); seasonMetricsCache.clear();
    const rows = await fetchMetricsForSeason(latestSeason, maxGames);
    populateTeamDropdown(rows); selectedTeam = ""; seasonSelect.disabled = false; metrics = rows;
    renderTable(); statusEl.textContent = `Loaded ${metrics.length} teams for ${latestSeason} using all ${maxGames} available games.`;
  } catch (error) { console.error(error); statusEl.textContent = `Failed: ${error.message}`; }
}
updateRiskUI(Number(lowerMarker.value), Number(higherMarker.value)); updateToggleUI(); styleColumnControls(); updateRecentGamesUI(); init();
