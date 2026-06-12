// 10. UI STATE & HANDLERS
// ============================================================

let state = {
  hvCsvText: null, popDf: null,
  hvFilename: '', predRows: null,
  hospDat: null, hospCumuSOrig: null, hospMissing: null, stateAbbr: null, popu: null, zeroDate: null,
  chart: null, _chartLoc: null, _chartKind: null, _chartCtx: null,
};

// Enable the bundled (offline) zoom/pan plugin for Chart.js.
if (window.ChartZoom) Chart.register(window.ChartZoom);

// Shared zoom/pan behaviour: mouse wheel + drag-box to zoom, hold-drag to pan.
const ZOOM_OPTS = {
  pan: { enabled: true, mode: 'xy', modifierKey: 'ctrl' },
  zoom: {
    wheel: { enabled: true },
    drag: { enabled: true, backgroundColor: 'rgba(102,126,234,0.15)',
            borderColor: '#667eea', borderWidth: 1 },
    mode: 'xy',
  },
};

// --- File upload handling ---
function setupFileDrop(dropId, inputId, onLoad) {
  const drop = document.getElementById(dropId);
  const input = document.getElementById(inputId);
  const readFile = f => {
    const reader = new FileReader();
    reader.onload = e => onLoad(e.target.result, f.name);
    reader.readAsText(f);
  };
  input.onchange = e => { if (e.target.files[0]) readFile(e.target.files[0]); };
  drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = '#667eea'; };
  drop.ondragleave = () => { drop.style.borderColor = ''; };
  drop.ondrop = e => {
    e.preventDefault(); drop.style.borderColor = '';
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  };
}

function onHvLoaded(text, name) {
  state.hvCsvText = text;
  state.hvFilename = name;
  document.getElementById('hv-drop-text').textContent = `✓ ${name}`;
  document.getElementById('hv-drop').classList.add('has-file');
  document.getElementById('hv-status').textContent = '';
  updateGenerateButton();
  populateTargetSelect();
  loadAndShowHistory();
}
setupFileDrop('hv-drop', 'hv-file', onHvLoaded);

// Targets the user has checked (empty when there is no target column).
function getSelectedTargets() {
  return [...document.querySelectorAll('#target-checkboxes input[type=checkbox]:checked')]
    .map(cb => cb.value);
}

// Discover the targets in the uploaded CSV and offer them as checkboxes (multi-select).
// When the CSV has no target column (implicit single target) there is nothing to
// choose, so the picker is hidden and a short note is shown instead.
function populateTargetSelect() {
  const box  = document.getElementById('target-checkboxes');
  const note = document.getElementById('target-note');
  document.getElementById('target-row').style.display = 'block';

  let targets = [];
  try { targets = listHubverseTargets(state.hvCsvText); } catch (e) { /* leave empty */ }

  if (!targets.length) {
    box.style.display = 'none';
    box.innerHTML = '';   // no checkboxes → no selection → implicit-target path in the parser
    note.textContent = 'No target column found — treating all data as a single implicit target.';
    return;
  }

  // Preserve any still-valid prior selection; otherwise default to the common
  // flu-hosp target if present, else the first one.
  const prev = new Set(getSelectedTargets());
  let defaults = targets.filter(t => prev.has(t));
  if (!defaults.length) defaults = [targets.includes('wk inc flu hosp') ? 'wk inc flu hosp' : targets[0]];
  const checked = new Set(defaults);

  box.style.display = '';
  note.textContent = 'Check one or more targets to forecast.';
  box.innerHTML = '';
  for (const t of targets) {
    const row = document.createElement('label');
    row.className = 'checkbox-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = t; cb.checked = checked.has(t);
    cb.onchange = () => { if (state.hvCsvText) loadAndShowHistory(); };
    row.appendChild(cb);
    row.appendChild(document.createTextNode(t));
    box.appendChild(row);
  }
}

function onPopLoaded(text, name) {
  const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  state.popDf = parsed.data;
  document.getElementById('pop-drop-text').textContent = `✓ ${name}`;
  document.getElementById('pop-drop').classList.add('has-file');
  document.getElementById('pop-status').textContent = '';
  // Re-parse with updated population if history already loaded
  if (state.hvCsvText) loadAndShowHistory();
}
setupFileDrop('pop-drop', 'pop-file', onPopLoaded);

// --- Quick-load shortcuts (fetch CSVs from the web; require internet) ---
const FLUSIGHT_HOSP_URL =
  'https://raw.githubusercontent.com/cdcepi/FluSight-forecast-hub/refs/heads/main/target-data/target-hospital-admissions.csv';
const US_POPULATION_URL =
  'https://raw.githubusercontent.com/scc-usc/LEMMA-lite/refs/heads/main/data/us_population_data.csv';

async function fetchCsvInto(url, name, btn, statusEl, onLoaded) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Loading…';
  if (statusEl) statusEl.textContent = '';
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text.trim()) throw new Error('Empty response');
    onLoaded(text, name);
  } catch (e) {
    if (statusEl) statusEl.textContent = `⚠ Could not load (need internet): ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

document.getElementById('load-flusight').onclick = function () {
  fetchCsvInto(FLUSIGHT_HOSP_URL, 'FluSight hospital admissions',
    this, document.getElementById('hv-status'), onHvLoaded);
};
document.getElementById('load-us-pop').onclick = function () {
  fetchCsvInto(US_POPULATION_URL, 'US states population',
    this, document.getElementById('pop-status'), onPopLoaded);
};

function updateGenerateButton() {
  // When the CSV has a target column, at least one target must be selected.
  const hasTargetCol = document.querySelectorAll('#target-checkboxes input[type=checkbox]').length > 0;
  const targetOk = !hasTargetCol || getSelectedTargets().length > 0;
  document.getElementById('generate-btn').disabled = !(state.hvCsvText && targetOk);
}

// Reads the Data Granularity control, sets the global analysis timestep (STEP_DAYS),
// updates step-unit wording, and returns the granularity string. Call before parsing.
let STEP_UNIT = 'week'; // 'week' or 'day' — for UI labels
function applyGranularity() {
  const g = document.getElementById('granularity').value;
  STEP_DAYS = (g === 'daily') ? 1 : 7;            // daily-to-weekly aggregates to weeks
  STEP_UNIT = (g === 'daily') ? 'day' : 'week';
  document.getElementById('weeks-ahead-label').textContent =
    (STEP_UNIT === 'day') ? 'Days Ahead' : 'Weeks Ahead';
  return g;
}

function loadAndShowHistory() {
  const targets = getSelectedTargets();
  const hasTargetCol = document.querySelectorAll('#target-checkboxes input[type=checkbox]').length > 0;
  updateGenerateButton();
  if (hasTargetCol && !targets.length) {
    document.getElementById('hv-status').textContent = 'Select at least one target to preview and forecast.';
    return;
  }
  document.getElementById('hv-status').textContent = '';
  try {
    const granularity = applyGranularity();
    const { hospRaw, popu, stateAbbr, zeroDate } =
      parseHubverseData(state.hvCsvText, state.popDf, targets, granularity);
    const { hospDat, hospCumuSOrig, hospMissing } = preprocessHospData(hospRaw);
    // Store in state (no forecast yet)
    state.hospDat      = hospDat;
    state.hospCumuSOrig = hospCumuSOrig;
    state.hospMissing  = hospMissing;
    state.stateAbbr    = stateAbbr;
    state.popu         = popu;
    state.zeroDate     = zeroDate;
    state.predRows     = null;   // clear any previous forecast
    state.config       = { weeksAhead: 4, quantiles: [], testLookback: [] };

    // Populate location selector
    const sel = document.getElementById('loc-select');
    sel.innerHTML = '';
    for (const abbr of stateAbbr) {
      const opt = document.createElement('option');
      opt.value = abbr; opt.textContent = abbr;
      sel.appendChild(opt);
    }
    sel.onchange = () => drawChart(stateAbbr.indexOf(sel.value));

    // Training-window and forecast-origin range sliders (under the plot)
    setupRangeSliders(hospDat[0].length, zeroDate);

    // Show the results panel with history-only chart
    document.getElementById('results-info').innerHTML =
      `<span class="info-chip">📍 ${stateAbbr.length} location${stateAbbr.length > 1 ? 's' : ''}</span>` +
      `<span class="info-chip">📅 ${hospDat[0].length} ${STEP_UNIT}${hospDat[0].length > 1 ? 's' : ''} of data</span>` +
      `<span class="info-chip badge">Upload complete — run forecast to add predictions</span>`;
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('results-container').style.display = 'flex';
    document.getElementById('download-btn').style.display = 'none';
    drawChart(0);
  } catch (e) {
    document.getElementById('hv-status').textContent = '⚠ ' + e.message;
  }
}

// --- Range sliders (under the plot) ---
// Two dual-handle ranges, both chosen by the user:
//   training window  (default: MIN_HISTORY_STEPS .. last observed step)
//   forecast origins (default: last observed step .. last observed step)
function setupRangeSliders(nSteps, zeroDate) {
  const maxOrigin = Math.max(0, nSteps - 1);
  const minOrigin = Math.min(maxOrigin, MIN_HISTORY_STEPS);
  const dateOf = w =>
    new Date(zeroDate.getTime() + w * STEP_DAYS * 86400000).toISOString().slice(0, 10);
  const def = defaultWindows(nSteps);

  wireDualRange('train-from', 'train-to', 'train-fill', 'train-range-label',
    minOrigin, maxOrigin, def.startTrain, def.endTrain, dateOf);
  wireDualRange('origin-from', 'origin-to', 'origin-fill', 'origin-range-label',
    minOrigin, maxOrigin, def.startTest, def.endTest, dateOf);
  document.getElementById('ranges').style.display = '';
}

// Wire two overlaid <input type=range> as a single dual-handle slider: keeps
// from <= to, draws the selected span in the fill bar, and labels the date range.
function wireDualRange(fromId, toId, fillId, labelId, min, max, defFrom, defTo, dateOf) {
  const from = document.getElementById(fromId);
  const to   = document.getElementById(toId);
  const fill = document.getElementById(fillId);
  const label = document.getElementById(labelId);
  for (const s of [from, to]) { s.min = min; s.max = max; }
  from.value = defFrom; to.value = defTo;
  const span = (max - min) || 1;
  const pct = v => ((v - min) / span) * 100;

  const render = (leader) => {
    let a = parseInt(from.value), b = parseInt(to.value);
    if (a > b) { if (leader === 'from') { b = a; to.value = b; } else { a = b; from.value = a; } }
    fill.style.left  = pct(a) + '%';
    fill.style.width = (pct(b) - pct(a)) + '%';
    label.textContent = a === b ? dateOf(a) : `${dateOf(a)} → ${dateOf(b)}`;
    // keep both handles grabbable when the range collapses near the right edge
    from.style.zIndex = a > (min + max) / 2 ? 6 : 4;
    to.style.zIndex = 5;
  };
  from.oninput = () => render('from');
  to.oninput   = () => render('to');
  render('to');
}

// --- Approach hyperparams UI ---
const HYPERPARAM_DEFS = {
  'Flatline': [
    { key: 'flat_k_list', label: 'Lag in {unit}s (flat_k_list)', default: '0, 1, 2', type: 'array' },
  ],
  'ARIMA': [
    { key: 'ar_p_list', label: 'AR orders in {unit}s (ar_p_list)', default: '2, 4', type: 'array' },
    { key: 'd_list', label: 'Differencing orders (d_list)', default: '0, 1, 2', type: 'array' },
  ],
};

function renderHyperparams() {
  const approach = document.getElementById('approach').value;
  const container = document.getElementById('hyperparams-container');
  container.innerHTML = '';
  const defs = HYPERPARAM_DEFS[approach] || [];
  for (const def of defs) {
    const div = document.createElement('div');
    div.className = 'form-row';
    div.innerHTML = `<label>${def.label.replace('{unit}', STEP_UNIT)}</label>
      <input type="text" id="hp-${def.key}" value="${def.default}">`;
    container.appendChild(div);
  }
}

function getHyperparams() {
  const approach = document.getElementById('approach').value;
  const result = {};
  for (const def of (HYPERPARAM_DEFS[approach] || [])) {
    const el = document.getElementById(`hp-${def.key}`);
    if (el) {
      result[def.key] = el.value.split(',').map(v => parseFloat(v.trim())).filter(v => isFinite(v));
    }
  }
  return result;
}

document.getElementById('approach').onchange = renderHyperparams;
applyGranularity();   // sync STEP_DAYS/STEP_UNIT/labels with the granularity control's initial value
renderHyperparams();

// --- RF settings visibility ---
document.getElementById('ensemble').onchange = function () {
  document.getElementById('rf-settings-section').style.display =
    this.value === 'Random Forest' ? 'block' : 'none';
};

// --- Status & progress helpers ---
function setStatus(msg, type = 'info') {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = `status-bar${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  bar.style.display = msg ? 'block' : 'none';
}

function setProgress(fraction) {
  const wrap = document.getElementById('progress-wrap');
  const bar  = document.getElementById('progress-bar');
  if (fraction <= 0 || fraction >= 1) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  bar.style.width = (fraction * 100).toFixed(1) + '%';
}

// ============================================================
// 11. GENERATE FORECAST (main entry)
// ============================================================

document.getElementById('generate-btn').onclick = runForecast;

async function runForecast() {
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('results-container').style.display = 'none';
  setProgress(0.01);
  setStatus('Parsing CSV data…');

  try {
    // --- Config collection ---
    const approachName   = document.getElementById('approach').value;
    const ensembleName   = document.getElementById('ensemble').value;
    const weeksAhead     = Math.max(1, parseInt(document.getElementById('weeks-ahead').value) || 4);
    const quantiles      = document.getElementById('quantiles').value
      .split(',').map(v => parseFloat(v.trim())).filter(v => isFinite(v) && v >= 0 && v <= 1).sort((a,b)=>a-b);
    const targets        = getSelectedTargets();
    const hyperparams    = getHyperparams();
    const rfTrees        = parseInt(document.getElementById('rf-trees').value) || 30;
    const rfDepth        = parseInt(document.getElementById('rf-depth').value) || 6;
    const rfSampleEl     = document.getElementById('rf-sample');
    // Rightmost slider position means "no limit" (Infinity); otherwise cap training rows.
    const rfMaxSample    = (parseInt(rfSampleEl.value) >= parseInt(rfSampleEl.max))
      ? Infinity : (parseInt(rfSampleEl.value) || 1000);
    const clipNegative   = document.getElementById('clip-negative').checked;

    if (!quantiles.length) throw new Error('Enter at least one valid quantile in [0,1].');

    const hasTargetCol = document.querySelectorAll('#target-checkboxes input[type=checkbox]').length > 0;
    if (hasTargetCol && !targets.length) throw new Error('Select at least one target to forecast.');

    // --- Parse Hubverse CSV ---
    const granularity = applyGranularity();
    const { hospRaw, popu, stateAbbr, zeroDate } =
      parseHubverseData(state.hvCsvText, state.popDf, targets, granularity);

    setProgress(0.05);
    setStatus('Preprocessing data…');
    await new Promise(r => setTimeout(r, 0));

    const { hospDat, hospCumuSOrig, hospMissing } = preprocessHospData(hospRaw);
    const nWeeks = hospDat[0].length;
    const nLoc  = hospDat.length;

    // --- Window computation (all in timesteps) ---
    // Both windows come from the sliders under the plot (training window + forecast
    // origin range); they may overlap (the user's choice).
    const def = defaultWindows(nWeeks);
    const slider = (id, fallback) => {
      const el = document.getElementById(id);
      const v = el ? parseInt(el.value) : NaN;
      return isFinite(v) ? v : fallback;
    };
    const startTrain = slider('train-from', def.startTrain);
    const endTrain   = slider('train-to',   def.endTrain);
    const startTest  = slider('origin-from', def.startTest);
    const endTest    = slider('origin-to',   def.endTest);

    const { retroLookback, trainLookback, testLookback } =
      buildLookbacks(nWeeks, weeksAhead, startTrain, endTrain, startTest, endTest);

    if (!testLookback.length) throw new Error('No valid forecast windows found. Check the origin range.');

    const config = {
      approachName, ensembleName, weeksAhead, quantiles,
      retroLookback, trainLookback, testLookback,
      nWeeks, zeroDate, stateAbbr, rfTrees, rfDepth, rfMaxSample, clipNegative
    };

    // --- Build scenarios ---
    const scenarios = buildScenarios(approachName, hyperparams);
    if (!scenarios.length) throw new Error('No scenarios generated. Check hyperparameters.');

    // --- Generate predictors ---
    setStatus(`Running ${scenarios.length} scenario(s) across ${retroLookback.length} lookback(s)…`);
    setProgress(0.1);

    const allPreds = await generateAllPredictors(
      hospCumuSOrig, hospDat, scenarios, config,
      frac => { setProgress(0.1 + 0.55 * frac); setStatus(`Generating predictors… ${Math.round(frac*100)}%`); }
    );

    setProgress(0.65);
    setStatus(`Running ${ensembleName} ensemble…`);
    await new Promise(r => setTimeout(r, 0));

    // --- Ensemble ---
    let allTestPreds;
    if (ensembleName === 'Random Forest') {
      allTestPreds = await generatePredsRF(allPreds, hospDat, popu, config, quantiles,
        frac => { setProgress(frac); setStatus(`Training RF ensemble… ${Math.round(frac*100)}%`); });
    } else {
      allTestPreds = await generatePredsBasic(allPreds, hospDat, popu, config, quantiles,
        frac => { setProgress(frac); setStatus(`Running Basic ensemble… ${Math.round(frac*100)}%`); });
    }

    setProgress(0.95);
    setStatus('Formatting output…');
    await new Promise(r => setTimeout(r, 0));

    // --- Output ---
    const predRows = predictionsToRows(allTestPreds, config, quantiles);
    state.predRows = predRows;
    state.hospDat  = hospDat;
    state.hospCumuSOrig = hospCumuSOrig;
    state.hospMissing = hospMissing;
    state.stateAbbr = stateAbbr;
    state.popu = popu;
    state.zeroDate = zeroDate;
    state.config = config;

    setProgress(1);
    setStatus(`Done! ${predRows.length} forecast rows across ${nLoc} location(s).`, 'success');

    renderResults(predRows, stateAbbr, weeksAhead, quantiles);

  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message, 'error');
    setProgress(0);
    document.getElementById('empty-state').style.display = 'flex';
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// 12. RESULTS RENDERING & CHART
// ============================================================

function renderResults(predRows, stateAbbr, weeksAhead, quantiles) {
  const nLoc = stateAbbr.length;

  // Location selector — already populated by loadAndShowHistory; reattach handler
  const sel = document.getElementById('loc-select');

  // Origin selector — collect unique sorted origin dates from predRows
  const originSel = document.getElementById('origin-select');
  const originLabel = document.getElementById('origin-label');
  const allOrigins = [...new Set(predRows.map(r => r.origin_date))].sort();
  originSel.innerHTML = '';
  for (const o of allOrigins) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    originSel.appendChild(opt);
  }
  // Default to latest origin
  originSel.value = allOrigins[allOrigins.length - 1];
  const showOrigin = allOrigins.length > 1;
  originSel.style.display = showOrigin ? '' : 'none';
  originLabel.style.display = showOrigin ? '' : 'none';

  const redraw = () => drawChart(stateAbbr.indexOf(sel.value));
  sel.onchange = redraw;
  originSel.onchange = redraw;

  // Update info chips
  document.getElementById('results-info').innerHTML =
    `<span class="info-chip">📍 ${nLoc} location${nLoc > 1 ? 's' : ''}</span>` +
    `<span class="info-chip">📅 ${allOrigins.length} origin${allOrigins.length > 1 ? 's' : ''}</span>` +
    `<span class="info-chip">📈 ${weeksAhead} ${STEP_UNIT}${weeksAhead > 1 ? 's' : ''} ahead</span>` +
    `<span class="info-chip">📊 ${predRows.length} rows</span>`;

  document.getElementById('download-btn').style.display = '';
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('results-container').style.display = 'flex';

  redraw();
}

// Chart click/hover handlers read their context from state._chartCtx so they keep
// working when the chart is updated in place (without being recreated).
function chartOriginClick(evt, elements) {
  const c = state._chartCtx;
  if (!c || !elements.length) return;
  const date = c.allLabels[elements[0].index];
  if (date && date !== c.selectedOrigin && c.availableOrigins.includes(date)) {
    document.getElementById('origin-select').value = date;
    drawChart(c.locIdx);
  }
}
function chartOriginHover(evt, elements) {
  const c = state._chartCtx;
  const date = (c && elements.length) ? c.allLabels[elements[0].index] : null;
  const overOrigin = !!(date && c.availableOrigins.includes(date));
  if (evt.native) evt.native.target.style.cursor = overOrigin ? 'pointer' : '';
}

function drawChart(locIdx) {
  const { hospDat, stateAbbr, zeroDate, config } = state;
  if (!hospDat || locIdx < 0) return;

  const { quantiles } = config;
  const locName = stateAbbr[locIdx];
  const hasForecast = !!(state.predRows && state.predRows.length);
  const nWeeks = hospDat[locIdx].length;
  const obs = hospDat[locIdx]; // one value per step
  const dateOf = w =>
    new Date(zeroDate.getTime() + w * STEP_DAYS * 86400000).toISOString().slice(0, 10);

  // Interpolated (originally-missing) steps are shown in a distinct colour, and the
  // tooltip says "Interpolated" instead of "Observed" for them.
  const OBS_COLOR = '#4a5568', INTERP_COLOR = '#dd6b20';
  const missing = state.hospMissing ? state.hospMissing[locIdx] : null;
  const isInterp = (i) => !!(missing && missing[i]);
  const obsPointColors = (n) => Array.from({ length: n }, (_, i) => isInterp(i) ? INTERP_COLOR : OBS_COLOR);
  const obsSegmentColor = (ctx) =>
    (isInterp(ctx.p0DataIndex) || isInterp(ctx.p1DataIndex)) ? INTERP_COLOR : OBS_COLOR;
  const tooltipLabel = (item) => {
    const ds = item.dataset.label || '';
    const shown = (ds.startsWith('Observed') && isInterp(item.dataIndex)) ? 'Interpolated' : ds;
    return `${shown}: ${item.formattedValue}`;
  };

  // --- No forecast yet: show the full observed history (aligns with the sliders). ---
  if (!hasForecast) {
    const startW = 0;
    const allLabels = [], histSlice = [];
    for (let w = startW; w < nWeeks; w++) { allLabels.push(dateOf(w)); histSlice.push(obs[w]); }
    const ctx = document.getElementById('forecast-chart').getContext('2d');
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: allLabels,
        datasets: [{
          label: `Observed (${STEP_UNIT === 'day' ? 'daily' : 'weekly'})`,
          data: histSlice,
          borderColor: OBS_COLOR,
          backgroundColor: 'rgba(74,85,104,0.12)',
          pointRadius: 2, pointHoverRadius: 5,
          borderWidth: 1.5, tension: 0.1,
          pointBackgroundColor: obsPointColors(allLabels.length),
          pointBorderColor: obsPointColors(allLabels.length),
          segment: { borderColor: obsSegmentColor },
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          title: { display: true, text: `${locName} — observed data`, font: { size: 16 } },
          legend: { labels: { font: { size: 14 } } },
          tooltip: { callbacks: { label: tooltipLabel } },
          zoom: ZOOM_OPTS,
        },
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { size: 13 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { ticks: { font: { size: 13 } }, grid: { color: 'rgba(0,0,0,0.05)' },
               title: { display: true, text: 'Count / Rate', font: { size: 14 } } },
        },
      },
    });
    state._chartLoc = locIdx;
    state._chartKind = 'history';
    return;
  }

  // --- Selected forecast origin ---
  const originSelEl = document.getElementById('origin-select');
  const fRows = state.predRows.filter(r => r.location === locName);
  const availableOrigins = [...new Set(fRows.map(r => r.origin_date))].sort();
  const selectedOrigin = (originSelEl && originSelEl.value && availableOrigins.includes(originSelEl.value))
    ? originSelEl.value
    : (availableOrigins.length ? availableOrigins[availableOrigins.length - 1] : null);
  const forecastRows = fRows.filter(r => r.origin_date === selectedOrigin);

  // --- Build per-horizon forecast values ---
  const medianIdx = quantiles.findIndex(q => Math.abs(q - 0.5)  < 0.01);
  const lo95Idx   = quantiles.findIndex(q => Math.abs(q - 0.025) < 0.05);
  const hi95Idx   = quantiles.findIndex(q => Math.abs(q - 0.975) < 0.05);
  const lo50Idx   = quantiles.findIndex(q => Math.abs(q - 0.25) < 0.05);
  const hi50Idx   = quantiles.findIndex(q => Math.abs(q - 0.75) < 0.05);

  const forecastByHorizon = {};
  for (const r of forecastRows) {
    if (!forecastByHorizon[r.horizon]) forecastByHorizon[r.horizon] = {};
    forecastByHorizon[r.horizon][parseFloat(r.output_type_id)] = r.value;
  }
  const horizons = Object.keys(forecastByHorizon).map(Number).sort((a, b) => a - b);

  const forecastMedian = horizons.map(h => medianIdx >= 0 ? (forecastByHorizon[h][quantiles[medianIdx]] ?? null) : null);
  const forecast95Lo   = horizons.map(h => lo95Idx >= 0   ? (forecastByHorizon[h][quantiles[lo95Idx]]   ?? null) : null);
  const forecast95Hi   = horizons.map(h => hi95Idx >= 0   ? (forecastByHorizon[h][quantiles[hi95Idx]]   ?? null) : null);
  const forecast50Lo   = horizons.map(h => lo50Idx >= 0   ? (forecastByHorizon[h][quantiles[lo50Idx]]   ?? null) : null);
  const forecast50Hi   = horizons.map(h => hi50Idx >= 0   ? (forecastByHorizon[h][quantiles[hi50Idx]]   ?? null) : null);

  // --- Weekly timeline ---
  // The origin is a week index; horizon h is plotted at week (origin + h). The full
  // ground truth is shown (observed values for every week with data, including weeks
  // overlapping the forecast for older origins), with ~52 weeks of context before
  // the origin and the timeline extended to cover both the data and the horizon.
  const originWeek = selectedOrigin
    ? Math.round((new Date(selectedOrigin).getTime() - zeroDate.getTime()) / (STEP_DAYS * 86400000))
    : nWeeks - 1;
  const maxHorizon = horizons.length ? Math.max(...horizons) : 0;
  const startW = 0; // full history, so the x-axis aligns with the range sliders
  const endW   = Math.max(nWeeks - 1, originWeek + maxHorizon);

  const allLabels = [], histData = [];
  for (let w = startW; w <= endW; w++) {
    allLabels.push(dateOf(w));
    histData.push(w < nWeeks ? obs[w] : null);
  }
  const nBins = allLabels.length;

  // Forecast series occupy week (origin + h).
  const placeForecast = (vals) => {
    const arr = new Array(nBins).fill(null);
    horizons.forEach((h, k) => {
      const idx = (originWeek + h) - startW;
      if (idx >= 0 && idx < nBins) arr[idx] = vals[k];
    });
    return arr;
  };
  const medianData   = placeForecast(forecastMedian);
  const band95LoData = placeForecast(forecast95Lo);
  const band95HiData = placeForecast(forecast95Hi);
  const band50LoData = placeForecast(forecast50Lo);
  const band50HiData = placeForecast(forecast50Hi);

  const ctx = document.getElementById('forecast-chart').getContext('2d');

  const datasets = [
    {
      label: `Observed (${STEP_UNIT === 'day' ? 'daily' : 'weekly'})`,
      data: histData,
      borderColor: OBS_COLOR,
      backgroundColor: 'rgba(74,85,104,0.15)',
      pointRadius: 3, pointHoverRadius: 5,
      borderWidth: 1.5, tension: 0.1,
      spanGaps: false,
      pointBackgroundColor: obsPointColors(histData.length),
      pointBorderColor: obsPointColors(histData.length),
      segment: { borderColor: obsSegmentColor },
    },
  ];

  if (forecast95Lo[0] !== null && forecast95Hi[0] !== null) {
    // Lower bound first, then the upper bound fills down to it (fill: '-1').
    datasets.push({
      label: '_lo95',
      data: band95LoData,
      borderColor: 'transparent', backgroundColor: 'rgba(102,126,234,0.15)',
      fill: false, pointRadius: 0, tension: 0.1, spanGaps: false,
    });
    datasets.push({
      label: '95% interval',
      data: band95HiData,
      borderColor: 'transparent', backgroundColor: 'rgba(102,126,234,0.15)',
      fill: '-1', pointRadius: 0, tension: 0.1, spanGaps: false,
    });
  }
  if (forecast50Lo[0] !== null && forecast50Hi[0] !== null) {
    datasets.push({
      label: '_lo50',
      data: band50LoData,
      borderColor: 'transparent', backgroundColor: 'rgba(102,126,234,0.3)',
      fill: false, pointRadius: 0, tension: 0.1, spanGaps: false,
    });
    datasets.push({
      label: '50% interval',
      data: band50HiData,
      borderColor: 'transparent', backgroundColor: 'rgba(102,126,234,0.3)',
      fill: '-1', pointRadius: 0, tension: 0.1, spanGaps: false,
    });
  }

  datasets.push({
    label: 'Forecast (median)',
    data: medianData,
    borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.8)',
    pointRadius: 5, pointHoverRadius: 7,
    borderWidth: 2, tension: 0.1, spanGaps: false,
    borderDash: [4, 3],
  });

  // Marker highlighting the currently-selected origin (also the click target).
  const originMarker = new Array(nBins).fill(null);
  const oIdx = originWeek - startW;
  if (oIdx >= 0 && oIdx < nBins && histData[oIdx] != null) originMarker[oIdx] = histData[oIdx];
  datasets.push({
    label: '_origin',
    data: originMarker,
    borderColor: '#e53e3e', backgroundColor: '#fff',
    pointRadius: 6, pointHoverRadius: 7, pointBorderWidth: 2,
    showLine: false, order: -1,
  });

  // Context for the (stable) click/hover handlers.
  const titleText = `${locName} — forecast from ${selectedOrigin ?? ''}`;
  state._chartCtx = { allLabels, availableOrigins, selectedOrigin, locIdx };

  // When only the origin changed (same location, chart already a forecast chart),
  // update in place so the zoom/pan plugin keeps the current view — recreating the
  // chart would reset the zoom and is also what made dragging feel laggy.
  if (state.chart && state._chartLoc === locIdx && state._chartKind === 'forecast') {
    state.chart.data.labels = allLabels;
    state.chart.data.datasets = datasets;
    state.chart.options.plugins.title.text = titleText;
    state.chart.options.plugins.subtitle.display = availableOrigins.length > 1;
    state.chart.update('none');
    return;
  }

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels: allLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      onClick: chartOriginClick,
      onHover: chartOriginHover,
      plugins: {
          title: { display: true, text: titleText, font: { size: 16 } },
        subtitle: { display: availableOrigins.length > 1, text: 'Tip: click a point on the line to set the forecast origin',
                    font: { size: 12, style: 'italic' }, color: '#a0aec0', padding: { bottom: 6 } },
        legend: { labels: { filter: (item) => !item.text.startsWith('_'), font: { size: 14 } } },
        tooltip: { filter: (item) => !item.dataset.label.startsWith('_'),
                   callbacks: { label: tooltipLabel } },
        zoom: ZOOM_OPTS,
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 13 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { ticks: { font: { size: 13 } }, grid: { color: 'rgba(0,0,0,0.05)' },
             title: { display: true, text: 'Count / Rate', font: { size: 14 } } },
      },
    },
  });
  state._chartLoc = locIdx;
  state._chartKind = 'forecast';
}

// ============================================================
// 13. DOWNLOAD
// ============================================================

document.getElementById('download-btn').onclick = () => {
  if (!state.predRows || !state.predRows.length) return;
  // For multi-target runs the series id is "location__target"; split it back into
  // separate location/target columns so the CSV stays valid Hubverse output.
  const multiTarget = state.predRows.some(r => String(r.location).includes('__'));
  const cols = multiTarget
    ? ['origin_date', 'horizon', 'location', 'target', 'output_type', 'output_type_id', 'value']
    : ['origin_date', 'horizon', 'location', 'output_type', 'output_type_id', 'value'];
  const header = cols.join(',');
  const lines = state.predRows.map(r => {
    const sep = String(r.location).indexOf('__');
    const row = (multiTarget && sep >= 0)
      ? { ...r, location: r.location.slice(0, sep), target: r.location.slice(sep + 2) }
      : r;
    return cols.map(c => {
      const v = row[c];
      const s = String(v ?? '');
      return s.includes(',') ? `"${s}"` : s;
    }).join(',');
  });
  const csv = [header, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'lemma_forecast.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
};

// --- Zoom reset (button + double-click on the chart) ---
document.getElementById('reset-zoom-btn').onclick = () => {
  if (state.chart && state.chart.resetZoom) state.chart.resetZoom();
};
document.getElementById('forecast-chart').addEventListener('dblclick', () => {
  if (state.chart && state.chart.resetZoom) state.chart.resetZoom();
});

// --- Data granularity: relabel week→day, re-render hyperparams, re-plot history ---
document.getElementById('granularity').onchange = () => {
  applyGranularity();
  renderHyperparams();
  if (state.hvCsvText) loadAndShowHistory();
};

// --- Help modal ---
(() => {
  const overlay = document.getElementById('help-overlay');
  const open  = () => overlay.classList.add('open');
  const close = () => overlay.classList.remove('open');
  document.getElementById('help-btn').onclick = open;
  document.getElementById('help-close').onclick = close;
  // Close when clicking the backdrop or pressing Escape.
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();

// --- RF sampling slider: live label ("No limit" at the far right) ---
(() => {
  const slider = document.getElementById('rf-sample');
  const label  = document.getElementById('rf-sample-label');
  const update = () => {
    label.textContent = (parseInt(slider.value) >= parseInt(slider.max))
      ? 'No limit' : Number(slider.value).toLocaleString();
  };
  slider.addEventListener('input', update);
  update();
})();

// Initial state
document.getElementById('rf-settings-section').style.display = 'block'; // RF is default
