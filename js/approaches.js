// 5. FLATLINE APPROACH
// ============================================================

// Returns array of scenarios: each is { k }. k is a lag in TIMESTEPS.
function flatlineScenarios(flatKList) {
  return flatKList.map(k => ({ k: Math.round(k) }));
}

// Returns (nLoc, horizon) cumulative predicted increments from the last observed step.
// k is the lag, in timesteps, of the increment that is held flat into the future.
function flatlineProcess(k, hospCumuS, horizon) {
  const nLoc = hospCumuS.length;
  const result = Array.from({ length: nLoc }, () => new Float64Array(horizon));
  for (let loc = 0; loc < nLoc; loc++) {
    const row = hospCumuS[loc];
    const inc = diff1D(row); // nTime-1
    const T = inc.length;
    const idx1 = Math.max(1, T - 1 - k);
    const lastInc = idx1 < T ? inc[idx1] : inc[T - 1];
    // cumsum of constant increment
    for (let h = 0; h < horizon; h++) result[loc][h] = lastInc * (h + 1);
  }
  return result; // (nLoc, horizon) = cumulative from base
}

// ============================================================
// 6. ARIMA APPROACH (AR(p,d,0))
// ============================================================

// p is the AR order in TIMESTEPS; d is the differencing order.
function arimaScenarios(arPList, dList) {
  const scens = [];
  for (const p of arPList) for (const d of dList) scens.push({ p: Math.round(p), d: Math.round(d) });
  return scens;
}

function _difference(series, d) {
  let x = Float64Array.from(series);
  for (let i = 0; i < d; i++) x = diff1D(x);
  return x;
}

function _invertDifference(lastValues, diffs, d) {
  if (d <= 0) return diffs;
  // Build "levels": last observed value at each differencing order
  const levels = [];
  let tmp = Float64Array.from(lastValues);
  for (let k = 0; k < d; k++) {
    levels.push(tmp.length > 0 ? tmp[tmp.length - 1] : 0);
    tmp = diff1D(tmp);
  }
  let out = Float64Array.from(diffs);
  for (let j = d - 1; j >= 0; j--) {
    const init = levels[j];
    const cummed = new Float64Array(out.length);
    let s = init;
    for (let t = 0; t < out.length; t++) { s += out[t]; cummed[t] = s; }
    out = cummed;
  }
  return out;
}

function _fitAR(x, p) {
  if (p <= 0 || x.length <= p) return new Float64Array(p);
  const T = x.length;
  const X = [];
  for (let t = p; t < T; t++) {
    const row = new Float64Array(p);
    for (let j = 0; j < p; j++) row[j] = x[t - p + j]; // [x_{t-p}, ..., x_{t-1}]
    X.push(row);
  }
  const y = x.slice(p); // x[p..T-1]
  return lstsq(X, y);
}

// Returns (nLoc, horizon) cumulative predicted increments from the last observed step.
function arimaProcess(p, d, hospCumuS, horizon) {
  const nLoc = hospCumuS.length;
  const result = Array.from({ length: nLoc }, () => new Float64Array(horizon));
  for (let loc = 0; loc < nLoc; loc++) {
    const row = hospCumuS[loc];
    const inc = diff1D(row); // daily increments of smoothed cumulative
    const x = _difference(inc, d);
    const coef = _fitAR(x, p);
    const hist = [...x.slice(Math.max(0, x.length - Math.max(p, 1)))];
    const fx = [];
    for (let h = 0; h < horizon; h++) {
      let pred = 0;
      if (p > 0 && hist.length >= p) {
        for (let j = 0; j < p; j++) pred += coef[j] * hist[hist.length - p + j];
      } else {
        pred = hist.length > 0 ? hist[hist.length - 1] : 0;
      }
      fx.push(pred);
      hist.push(pred);
    }
    const fxArr = new Float64Array(fx);
    let incPred;
    if (d > 0) {
      const lastVals = inc.slice(Math.max(0, inc.length - d));
      incPred = _invertDifference(lastVals, fxArr, d);
    } else {
      incPred = fxArr;
    }
    // Cumulative from base
    let cum = 0;
    for (let h = 0; h < horizon; h++) { cum += incPred[h]; result[loc][h] = cum; }
  }
  return result;
}
