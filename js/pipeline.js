// 9. MAIN FORECAST PIPELINE (weekly)
// ============================================================
//
// One timestep = one data point (a week or a day, per the granularity setting; the
// algorithm is unit-agnostic). Hyperparameters (flatline lag, ARIMA AR order) and all
// windows/lookbacks are expressed in timesteps. The forecasters emit one value per
// step, which is exactly the forecast for that step.

function buildScenarios(approachName, hyperparams) {
  if (approachName === 'Flatline') {
    return flatlineScenarios(hyperparams.flat_k_list || [0, 1, 2]);
  } else { // ARIMA
    return arimaScenarios(hyperparams.ar_p_list || [2, 4], hyperparams.d_list || [0, 1, 2]);
  }
}

function runScenario(scen, approachName, hospCumuSCut, horizon) {
  if (approachName === 'Flatline') {
    return flatlineProcess(scen.k, hospCumuSCut, horizon);
  } else {
    return arimaProcess(scen.p, scen.d, hospCumuSCut, horizon);
  }
}

// Generate all predictors for all lookbacks.
// Returns: Map(lookback → Array[nScen][nLoc][weeksAhead]) of per-week forecasts.
async function generateAllPredictors(hospCumuSOrig, hospDat, scenarios, config, progressCallback) {
  const { retroLookback, weeksAhead } = config;
  const nWeeks = hospDat[0].length;
  const horizon = weeksAhead;
  const nLoc = hospDat.length;
  const nScen = scenarios.length;

  const allPreds = new Map();
  let done = 0;

  for (const lb of retroLookback) {
    const cutLen = nWeeks - lb; // weeks of data used; origin week = cutLen - 1
    if (cutLen <= 0) { done++; progressCallback(done / retroLookback.length); continue; }

    const hospCumuSCut = hospCumuSOrig.map(row => row.slice(0, cutLen));

    // (nScen, nLoc, horizon) cumulative predicted increments from the last observed week
    const cumPreds = Array.from({ length: nScen }, (_, si) =>
      runScenario(scenarios[si], config.approachName, hospCumuSCut, horizon)
    );

    // Per-week increments. cumPreds[..][0] is already the first forecast week's
    // increment, so we prepend the base level (0) before differencing — a plain
    // diff would drop it and shift the forecast one week late.
    const preds = cumPreds.map(scenMat =>
      scenMat.map(locRow => {
        const out = new Float64Array(weeksAhead);
        out[0] = locRow[0];
        for (let h = 1; h < weeksAhead; h++) out[h] = locRow[h] - locRow[h - 1];
        // Predictor-level clip: a forecast for a period should not be negative.
        if (config.clipNegative) for (let h = 0; h < weeksAhead; h++) if (out[h] < 0) out[h] = 0;
        return out;
      })
    );
    allPreds.set(lb, preds);

    done++;
    progressCallback(done / retroLookback.length);
    await new Promise(resolve => setTimeout(resolve, 0)); // keep UI responsive
  }
  return allPreds;
}

// Normalize a lookback's predictors by population: (nScen, nLoc, weeksAhead).
function normalizePreds(preds, popu) {
  return preds.map(scenMat =>
    scenMat.map((locRow, locI) => Array.from(locRow, v => v / popu[locI]))
  );
}

// Build training data for RF: X (n_samples, nScen*weeksAhead), Y (n_samples, weeksAhead)
// Trains on the user's training window (config.trainLookback). Each training origin
// contributes its actual future weekly values as targets (a horizon is dropped only
// if that week is past the end of the data). No leakage masking — if the training and
// forecast windows overlap, that is the user's choice.
function buildRFTrainData(allPreds, hospDat, popu, config) {
  const { trainLookback, weeksAhead } = config;
  const nWeeks = hospDat[0].length;
  const nLoc = hospDat.length;

  const XList = [], YList = [], WList = [];
  const lbs = trainLookback.filter(lb => allPreds.has(lb));
  if (!lbs.length) return { XList, YList, WList };

  for (const lb of lbs) {
    const predsNorm = normalizePreds(allPreds.get(lb), popu);
    const nScen = predsNorm.length;
    const origin = (nWeeks - 1) - lb;            // last observed week for this lookback

    for (let loc = 0; loc < nLoc; loc++) {
      const xRow = [];
      for (let si = 0; si < nScen; si++)
        for (let wa = 0; wa < weeksAhead; wa++) xRow.push(predsNorm[si][loc][wa]);

      // Y row: actual future weekly values, normalized.
      const yRow = new Float64Array(weeksAhead).fill(NaN);
      for (let wa = 0; wa < weeksAhead; wa++) {
        const tWeek = origin + 1 + wa;
        if (tWeek < nWeeks) yRow[wa] = hospDat[loc][tWeek] / popu[loc];
      }

      XList.push(xRow);
      YList.push(yRow);
      WList.push(1); // equal weights (no decay)
    }
  }
  return { XList, YList, WList };
}

// Predict using RF ensemble (trained once on the single training window).
async function generatePredsRF(allPreds, hospDat, popu, config, quantiles, progressCallback) {
  const { testLookback, weeksAhead } = config;
  const nLoc = hospDat.length;

  const { XList, YList, WList } = buildRFTrainData(allPreds, hospDat, popu, config);

  // Train one RF per week ahead
  const nTrees = config.rfTrees || 30;
  const rfDepth = config.rfDepth || 6;
  const maxSample = config.rfMaxSample || Infinity; // cap on training rows (sampling)
  const forests = [];

  for (let wa = 0; wa < weeksAhead; wa++) {
    const y = YList.map(yRow => yRow[wa]);
    const valid = XList.map((_, i) => isFinite(y[i]));
    let Xvalid = XList.filter((_, i) => valid[i]);
    let yValid = y.filter((_, i) => valid[i]);
    let wValid = WList.filter((_, i) => valid[i]); // recency-decay weights

    // Subsample to keep training fast when there are many rows (long window × many locations).
    if (Xvalid.length > maxSample) {
      const keep = sampleIndices(Xvalid.length, maxSample);
      Xvalid = keep.map(i => Xvalid[i]);
      yValid = keep.map(i => yValid[i]);
      wValid = keep.map(i => wValid[i]);
    }

    if (Xvalid.length < 5) {
      console.warn(`RF week ${wa + 1}: only ${Xvalid.length} valid training rows — ` +
        'forecast values will be 0 for this horizon. Use more history or switch to Basic ensemble.');
      forests.push(null);
    } else {
      const rf = new QuantileForest(nTrees, rfDepth, 5);
      rf.fit(Xvalid, yValid, wValid);
      forests.push(rf);
    }
    progressCallback(0.7 + 0.1 * (wa + 1) / weeksAhead);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const allTestPreds = new Map();
  let done = 0;
  const total = testLookback.length * nLoc;

  for (const lb of testLookback) {
    if (!allPreds.has(lb)) continue;
    const predsNorm = normalizePreds(allPreds.get(lb), popu);
    const nScen = predsNorm.length;

    for (let loc = 0; loc < nLoc; loc++) {
      const xRow = [];
      for (let si = 0; si < nScen; si++)
        for (let wa = 0; wa < weeksAhead; wa++) xRow.push(predsNorm[si][loc][wa]);

      const qPred = Array.from({ length: weeksAhead }, () => new Float64Array(quantiles.length));
      for (let wa = 0; wa < weeksAhead; wa++) {
        const rf = forests[wa];
        for (let qi = 0; qi < quantiles.length; qi++) {
          let v = rf ? rf.predictQuantile(xRow, quantiles[qi]) * popu[loc] : 0;
          if (config.clipNegative && v < 0) v = 0; // ensemble-level clip
          qPred[wa][qi] = v;
        }
      }
      allTestPreds.set(`${lb},${loc}`, qPred);
      done++;
      if (done % 10 === 0) progressCallback(0.8 + 0.2 * done / total);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return allTestPreds;
}

// Predict using Basic ensemble (quantiles directly across scenarios)
async function generatePredsBasic(allPreds, hospDat, popu, config, quantiles, progressCallback) {
  const { testLookback, weeksAhead } = config;
  const nLoc = hospDat.length;
  const allTestPreds = new Map();
  let done = 0;
  const total = testLookback.length * nLoc;

  for (const lb of testLookback) {
    if (!allPreds.has(lb)) continue;
    const preds = allPreds.get(lb); // (nScen, nLoc, weeksAhead) per-week values

    for (let loc = 0; loc < nLoc; loc++) {
      const pLoc = preds.map(scenMat => scenMat[loc]); // (nScen, weeksAhead)
      // Xw: (weeksAhead, nScen) - the scenarios' values for each week
      const Xw = Array.from({ length: weeksAhead }, (_, w) =>
        pLoc.map(scenRow => scenRow[w] || 0)
      );
      const qPred = basicEnsemblePredict(Xw, quantiles);
      // Ensemble-level clip: keep quantile forecasts non-negative.
      if (config.clipNegative) {
        for (const row of qPred) for (let i = 0; i < row.length; i++) if (row[i] < 0) row[i] = 0;
      }
      allTestPreds.set(`${lb},${loc}`, qPred);
      done++;
    }
    progressCallback(0.7 + 0.3 * done / total);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return allTestPreds;
}

// Convert predictions to Hubverse-format rows
function predictionsToRows(allTestPreds, config, quantiles) {
  const { testLookback, weeksAhead, nWeeks, zeroDate, stateAbbr } = config;
  const rows = [];
  const stepMs = STEP_DAYS * 86400000;

  for (const lb of testLookback) {
    // origin_date = last observed week used (week index nWeeks-1-lb).
    const originWeek = (nWeeks - 1) - lb;
    const originStr = new Date(zeroDate.getTime() + originWeek * stepMs).toISOString().slice(0, 10);

    for (let loc = 0; loc < stateAbbr.length; loc++) {
      const predMatrix = allTestPreds.get(`${lb},${loc}`);
      if (!predMatrix) continue;

      for (let wa = 0; wa < weeksAhead; wa++) {
        for (let qi = 0; qi < quantiles.length; qi++) {
          rows.push({
            origin_date: originStr,
            horizon: wa + 1, // weeks ahead; target_end_date = origin + horizon weeks
            location: stateAbbr[loc],
            output_type: 'quantile',
            output_type_id: quantiles[qi].toFixed(4),
            value: predMatrix[wa][qi],
          });
        }
      }
    }
  }
  return rows;
}
