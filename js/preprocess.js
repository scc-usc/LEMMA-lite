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

// Linearly interpolate missing (NaN) entries of a 1D series. Interior gaps are filled
// along the straight line between the nearest present points on either side; leading/
// trailing gaps are filled with the nearest present value. Returns the filled copy and
// a boolean mask flagging which positions were missing (interpolated).
function interpolateMissing(row) {
  const n = row.length;
  const out = Float64Array.from(row);
  const missing = new Array(n).fill(false);
  for (let t = 0; t < n; t++) if (!isFinite(out[t])) missing[t] = true;
  for (let t = 0; t < n; t++) {
    if (!missing[t]) continue;
    let prev = -1, next = -1;
    for (let j = t - 1; j >= 0; j--) if (!missing[j]) { prev = j; break; }
    for (let j = t + 1; j < n; j++) if (!missing[j]) { next = j; break; }
    if (prev >= 0 && next >= 0) out[t] = out[prev] + (out[next] - out[prev]) * (t - prev) / (next - prev);
    else if (prev >= 0) out[t] = out[prev];
    else if (next >= 0) out[t] = out[next];
    else out[t] = 0; // entirely empty series
  }
  return { values: out, missing };
}

// Preprocessing for the (weekly or daily) step series.
// hospRaw: (nLoc, nSteps) values per step per location; NaN marks a missing step.
// Returns:
//   hospDat       — cleaned values (missing steps linearly interpolated, negatives clamped)
//   hospCumuSOrig — their running cumulative, which the forecasters difference back
//                   to the per-step series.
//   hospMissing   — (nLoc, nSteps) boolean mask: true where a value was interpolated.
function preprocessHospData(hospRaw) {
  const nWeeks = hospRaw[0].length;

  // Interpolate missing steps in the value domain (must happen before cumsum, which
  // would otherwise propagate NaN forward and defeat interpolation).
  const hospMissing = [];
  const filled = hospRaw.map(row => {
    const { values, missing } = interpolateMissing(row);
    hospMissing.push(missing);
    return values;
  });

  // cumsum of filled → cumulative; clean it (clamp decreases to 0).
  const cumRaw = cumsum2D(filled);
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
  return { hospDat, hospCumuSOrig, hospMissing };
}
