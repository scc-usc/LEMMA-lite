// 2. SMOOTHING / PREPROCESSING
// ============================================================

// Mirrors Python smooth_epidata(data, smooth_factor, week_correction=0, week_smoothing=0)
function smoothEpidata(matrix, smoothFactor = 14) {
  if (smoothFactor <= 0) return matrix.map(row => Float64Array.from(row));
  const nTime = matrix[0].length;
  return matrix.map(rawRow => {
    const row = Float64Array.from(rawRow);
    // Interpolate NaN
    for (let t = 0; t < nTime; t++) {
      if (!isFinite(row[t])) {
        let prev = -1, next = -1;
        for (let j = t - 1; j >= 0; j--) if (isFinite(row[j])) { prev = j; break; }
        for (let j = t + 1; j < nTime; j++) if (isFinite(row[j])) { next = j; break; }
        if (prev >= 0 && next >= 0) {
          row[t] = row[prev] + (row[next] - row[prev]) * (t - prev) / (next - prev);
        } else if (prev >= 0) row[t] = row[prev];
        else if (next >= 0) row[t] = row[next];
        else row[t] = 0;
      }
    }
    // Daily diffs, clamp to 0
    const diffs = new Float64Array(nTime - 1);
    for (let t = 0; t < nTime - 1; t++) diffs[t] = Math.max(0, row[t + 1] - row[t]);
    // Rolling backward mean
    const smoothed = new Float64Array(nTime - 1);
    for (let t = 0; t < nTime - 1; t++) {
      const start = Math.max(0, t - smoothFactor + 1);
      let sum = 0;
      for (let j = start; j <= t; j++) sum += diffs[j];
      smoothed[t] = sum / (t - start + 1);
    }
    // Reconstruct: prepend original first value
    const out = new Float64Array(nTime);
    out[0] = row[0];
    for (let t = 0; t < smoothed.length; t++) out[t + 1] = out[t] + smoothed[t];
    return out;
  });
}

// Preprocessing for weekly data.
// hospRaw: (nLoc, nWeeks) weekly values (one point per week per location).
// Returns:
//   hospDat       — cleaned weekly values (NaN-interpolated, negatives clamped)
//   hospCumuSOrig — their running cumulative, which the forecasters difference back
//                   to the weekly series. No additional smoothing is applied: the
//                   data is already weekly-aggregated, so day-level smoothing (the
//                   old factor-14 step) does not apply.
function preprocessHospData(hospRaw) {
  const nWeeks = hospRaw[0].length;

  // cumsum of raw → cumulative; clean it (interpolate NaN, clamp decreases to 0).
  const cumRaw = cumsum2D(hospRaw);
  const hospDatCumu = smoothEpidata(cumRaw, 1);

  // Cleaned weekly values = first difference of the cleaned cumulative, keeping the
  // first week (week 0 = cumulative[0]).
  const hospDat = hospDatCumu.map(row => {
    const out = new Float64Array(nWeeks);
    out[0] = row[0];
    for (let t = 1; t < nWeeks; t++) out[t] = row[t] - row[t - 1];
    return out;
  });

  const hospCumuSOrig = cumsum2D(hospDat);
  return { hospDat, hospCumuSOrig };
}
