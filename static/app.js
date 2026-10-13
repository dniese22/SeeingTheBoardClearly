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

let metrics = [];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function updateRiskUI(lowerPct, higherPct) {
  lowerPct = clamp(Number(lowerPct), 0, 100);
  higherPct = clamp(Number(higherPct), 0, 100);

  if (lowerPct > higherPct) {
    const tmp = lowerPct;
    lowerPct = higherPct;
    higherPct = tmp;
  }

  lowerMarker.value = String(lowerPct);
  higherMarker.value = String(higherPct);

  lowerLabel.textContent = `${lowerPct}%`;
  higherLabel.textContent = `${higherPct}%`;

  segLower.style.left = "0%";
  segLower.style.width = `${lowerPct}%`;

  segMiddle.style.left = `${lowerPct}%`;
  segMiddle.style.width = `${Math.max(0, higherPct - lowerPct)}%`;

  segHigher.style.left = `${higherPct}%`;
  segHigher.style.width = `${Math.max(0, 100 - higherPct)}%`;
}

function formatPct(x) {
  if (x === null || x === undefined) return "—";
  const n = Number(x);
  if (Number.isNaN(n)) return "—";

  // backend returns 0..1, UI expects 0..100
  return `${(n * 100).toFixed(1)}%`;
}

function applyColoring() {
  const lower = Number(lowerMarker.value);
  const higher = Number(higherMarker.value);

  const cells = tbody.querySelectorAll("td.metric-cell");
  cells.forEach((cell) => {
    cell.classList.remove("val-red", "val-yellow", "val-green");

    const text = (cell.textContent || "").trim();
    const n = Number(text.replace("%", ""));
    if (Number.isNaN(n)) return;

    if (n < lower) cell.classList.add("val-red");
    else if (n > higher) cell.classList.add("val-green");
    else cell.classList.add("val-yellow");
  });
}

function renderTable() {
  tbody.innerHTML = "";

  metrics.forEach((row) => {
    const team =
      row.team_name ??
      row.team ??
      row.Team ??
      row.abbr ??
      row.team_abbr ??
      "Unknown";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${team}</td>
      <td class="metric-cell" data-metric="win_pct">${formatPct(row.win_pct)}</td>
      <td class="metric-cell" data-metric="over_pct">${formatPct(row.over_pct)}</td>
      <td class="metric-cell" data-metric="ats_pct">${formatPct(row.ats_pct)}</td>
    `;
    tbody.appendChild(tr);
  });

  applyColoring();
}

function handleRiskChange() {
  updateRiskUI(lowerMarker.value, higherMarker.value);
  applyColoring();
}

lowerMarker.addEventListener("input", handleRiskChange);
higherMarker.addEventListener("input", handleRiskChange);

// ✅ Season loading
async function fetchSeasons() {
  const res = await fetch("/api/team_metrics/seasons");
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
  const data = await res.json();
  return data.seasons || [];
}

async function fetchMetricsForSeason(season) {
  const url = `/api/team_metrics?season=${encodeURIComponent(season)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(data.message || "API error");
  return data.teams || [];
}

async function init() {
  try {
    statusEl.textContent = "Loading seasons...";

    const seasons = await fetchSeasons();
    if (!seasons.length) throw new Error("No seasons returned by API.");

    // populate select
    seasonSelect.innerHTML = "";
    seasons.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = String(s);
      opt.textContent = String(s);
      seasonSelect.appendChild(opt);
    });

    // default to most recent season (assumes ascending; fallback to last)
    const initial = String(seasons[seasons.length - 1]);
    seasonSelect.value = initial;

    statusEl.textContent = `Loading metrics for season ${initial}...`;
    metrics = await fetchMetricsForSeason(initial);
    statusEl.textContent = `Loaded ${metrics.length} teams for ${initial}.`;
    renderTable();

    seasonSelect.addEventListener("change", async () => {
      const season = seasonSelect.value;
      statusEl.textContent = `Loading metrics for season ${season}...`;
      metrics = await fetchMetricsForSeason(season);
      statusEl.textContent = `Loaded ${metrics.length} teams for ${season}.`;
      renderTable();
    });
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Failed: ${err.message}`;
  }
}

updateRiskUI(Number(lowerMarker.value), Number(higherMarker.value));
init();