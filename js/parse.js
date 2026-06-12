// 3. HUBVERSE CSV PARSING
// ============================================================

// Distinct non-blank `target` values present in a Hubverse CSV, sorted.
// Returns [] when there is no target column, or the column is blank for every
// row — i.e. the data is for a single implicit target with nothing to choose.
function listHubverseTargets(csvText) {
  const parsed = Papa.parse(csvText.trim(), {
    header: true, skipEmptyLines: true, dynamicTyping: false
  });
  const rows = parsed.data;
  if (!Object.keys(rows[0] || {}).includes('target')) return [];
  const set = new Set();
  for (const r of rows) {
    const t = String(r.target ?? '').trim();
    if (t) set.add(t);
  }
  return [...set].sort();
}

// Returns { hospRaw, popu, stateAbbr, zeroDate }
// hospRaw: (nLoc, nWeeks) - WEEKLY grid from minDate to maxDate, one column per week.
// Hubverse target data is expected to have one row per week per target, so each
// observation maps to exactly one weekly column.
// `targetFilters` may be an array of selected targets (or a single string). When
// the data has a target column, the selection picks which targets to forecast;
// multiple selections are kept as separate `location__target` series.
//
// `granularity` is 'weekly' (default), 'daily', or 'daily-to-weekly'. For
// 'daily-to-weekly' each observation date is snapped to its week-ending Saturday so
// that daily rows aggregate into weekly (MMWR) bins; the caller sets STEP_DAYS to
// match (7 for weekly/daily-to-weekly, 1 for daily).
function parseHubverseData(csvText, locationDf, targetFilters, granularity) {
  const parsed = Papa.parse(csvText.trim(), {
    header: true, skipEmptyLines: true, dynamicTyping: false
  });
  let rows = parsed.data;

  const cols = Object.keys(rows[0] || {});

  // Value column — accept the common Hubverse aliases, in order of preference.
  // Count columns ('observation'/'value') are preferred over 'weekly_rate' because
  // the forecast target is in counts: the output must be in counts, and counts let
  // the population file normalize by each location's actual population. 'weekly_rate'
  // is only a flat per-100k rate, so it is used only when no count column exists.
  const valueCol = ['observation', 'value', 'weekly_rate'].find(c => cols.includes(c));
  if (!valueCol) {
    throw new Error("Hubverse CSV must contain an 'observation', 'value', or 'weekly_rate' " +
      `column. Found: ${cols.join(', ')}`);
  }

  // Date column — oracle-output uses 'target_end_date'; time-series target data uses 'date'.
  const dateCol = ['target_end_date', 'date'].find(c => cols.includes(c));
  if (!dateCol) {
    throw new Error("Hubverse CSV must contain a 'target_end_date' or 'date' column. " +
      `Found: ${cols.join(', ')}`);
  }

  // Normalize strings (date is stored under target_end_date for the rest of the pipeline).
  rows = rows.map(r => ({
    ...r,
    location: String(r.location ?? '').trim(),
    target_end_date: r[dateCol] ? String(r[dateCol]).trim() : null,
    [valueCol]: parseFloat(r[valueCol]),
  })).filter(r => r.location && r.target_end_date && isFinite(r[valueCol]));

  // Target handling. The `target` column is optional: if it is absent — or present
  // but blank for every row — all data is treated as a single implicit target, and
  // the target selection is ignored (one series per location).
  if (cols.includes('target')) {
    rows = rows.map(r => ({ ...r, target: String(r.target ?? '').trim() }));
  }
  const hasTarget = rows.some(r => r.target); // at least one non-blank target value

  // Normalize the selection to an array of non-blank target names.
  const selected = (Array.isArray(targetFilters) ? targetFilters : [targetFilters])
    .map(t => String(t ?? '').trim()).filter(Boolean);

  if (hasTarget) {
    if (selected.length) {
      const sel = new Set(selected);
      rows = rows.filter(r => sel.has(r.target));
      if (!rows.length) throw new Error(`No rows match the selected target(s): ${selected.join(', ')}.`);
      // One target → a single series per location; multiple → separate series per target.
      rows = selected.length === 1
        ? rows.map(r => ({ ...r, row_id: r.location }))
        : rows.map(r => ({ ...r, row_id: r.location + '__' + r.target }));
    } else {
      // Nothing selected → keep every target as its own series.
      rows = rows.map(r => ({ ...r, row_id: r.location + '__' + r.target }));
    }
  } else {
    // Implicit target — one series per location.
    rows = rows.map(r => ({ ...r, row_id: r.location }));
  }

  // Parse dates
  rows = rows.map(r => ({ ...r, _date: new Date(r.target_end_date) }))
             .filter(r => !isNaN(r._date));

  // Daily-to-weekly: snap each date to its week-ending Saturday (MMWR convention) so
  // that all days in a week collapse onto one weekly bin and get summed below.
  if (granularity === 'daily-to-weekly') {
    for (const r of rows) {
      const d = r._date;
      const addDays = (6 - d.getUTCDay() + 7) % 7; // days forward to the next Saturday
      r._date = new Date(d.getTime() + addDays * 86400000);
    }
  }

  if (!rows.length) {
    throw new Error("No valid rows in Hubverse CSV after filtering. Check that " +
      `'location', '${dateCol}', and '${valueCol}' are populated with valid values.`);
  }

  // Date range (daily resolution) — avoid spread into Math.min/max (stack overflow on large arrays)
  const allDates = rows.map(r => r._date.getTime());
  let minTs = allDates[0], maxTs = allDates[0];
  for (let i = 1; i < allDates.length; i++) {
    if (allDates[i] < minTs) minTs = allDates[i];
    if (allDates[i] > maxTs) maxTs = allDates[i];
  }
  const minDate = new Date(minTs);
  const maxDate = new Date(maxTs);
  minDate.setUTCHours(0, 0, 0, 0);
  maxDate.setUTCHours(0, 0, 0, 0);
  const stepMs = STEP_DAYS * 86400000;
  const nWeeks = Math.round((maxDate - minDate) / stepMs) + 1;

  // Unique row_ids in order of first appearance
  const rowOrder = [];
  const seen = new Set();
  for (const r of rows) {
    if (!seen.has(r.row_id)) { rowOrder.push(r.row_id); seen.add(r.row_id); }
  }
  const nLoc = rowOrder.length;
  const rowIdx = Object.fromEntries(rowOrder.map((id, i) => [id, i]));

  // Build matrix (nLoc, nWeeks) initialized to 0; each observation maps to its week.
  const hospRaw = Array.from({ length: nLoc }, () => new Float64Array(nWeeks));
  const minDateTs = minDate.getTime();
  for (const r of rows) {
    const locI = rowIdx[r.row_id];
    const wI = Math.round((r._date.getTime() - minDateTs) / stepMs);
    if (locI !== undefined && wI >= 0 && wI < nWeeks) {
      hospRaw[locI][wI] += r[valueCol]; // sum if multiple rows fall in the same week
    }
  }

  // Population
  const baseLocations = rowOrder.map(id => id.split('__')[0]);
  let popu;
  if (valueCol === 'weekly_rate') {
    popu = new Float64Array(nLoc).fill(1.0);
  } else {
    let matMax = 0;
    for (const row of hospRaw) for (const v of row) if (v > matMax) matMax = v;
    const dummyPop = Math.max(1, 100 * matMax);
    const popMap = {};
    if (locationDf) {
      for (const row of locationDf) {
        const name = String(row.location_name ?? '').trim();
        const p = parseFloat(row.population);
        if (name && isFinite(p) && p > 0) popMap[name] = p;
      }
    }
    popu = new Float64Array(nLoc);
    for (let i = 0; i < nLoc; i++) {
      const p = popMap[baseLocations[i]];
      popu[i] = (p !== undefined && isFinite(p) && p > 0) ? p : dummyPop;
    }
  }

  return { hospRaw, popu, stateAbbr: rowOrder, zeroDate: minDate };
}
