// 4. WINDOW / LOOKBACK COMPUTATION (weekly)
// ============================================================
//
// Everything is in WEEKS. An "origin" is the index of the last observed week used
// to make a forecast. A "lookback" lb is how many weeks are held back from the end:
//
//   lb = (nWeeks - 1) - origin        cutLen (weeks used) = nWeeks - lb
//
// so lb = 0 forecasts from the most recent week. The training window and the forecast
// origin range are BOTH chosen by the user (the two sliders under the plot). If they
// overlap, training targets may coincide with the forecast period (leakage) — that is
// the user's choice; nothing is masked here.

// Weeks of history skipped at the start so the earliest training origin still has
// enough past data to form the forecaster inputs.
const MIN_HISTORY_WEEKS = 8;

function buildLookbacks(nWeeks, weeksAhead, startTrain, endTrain, startTest, endTest) {
  const maxOrigin = Math.max(0, nWeeks - 1);
  const clip = (v) => Math.min(maxOrigin, Math.max(0, Math.round(v)));
  startTrain = clip(startTrain); endTrain = clip(endTrain);
  startTest  = clip(startTest);  endTest  = clip(endTest);
  if (endTrain < startTrain) [startTrain, endTrain] = [endTrain, startTrain];
  if (endTest  < startTest)  [startTest,  endTest]  = [endTest,  startTest];

  const toLb = (origin) => (nWeeks - 1) - origin;
  const trainLookback = range(startTrain, endTrain + 1).map(toLb).filter(v => v >= 0);
  const testLookback  = range(startTest,  endTest  + 1).map(toLb).filter(v => v >= 0);
  const retroLookback = [...new Set([...trainLookback, ...testLookback])].sort((a, b) => a - b);

  return { retroLookback, trainLookback, testLookback, maxOrigin };
}

// Default window positions (used to initialise the sliders):
//   training window  = last 52 weeks if available, else from the warm-up start
//                      (>= MIN_HISTORY_WEEKS) .. last observed week
//   forecast origins = last observed week .. last observed week
function defaultWindows(nWeeks) {
  const maxOrigin = Math.max(0, nWeeks - 1);
  const startTrain = Math.min(maxOrigin, Math.max(MIN_HISTORY_WEEKS, maxOrigin - 51));
  return {
    startTrain,
    endTrain: maxOrigin,
    startTest: maxOrigin,
    endTest: maxOrigin,
  };
}

function dateToWeekIndex(dateStr, zeroDate) {
  const d = new Date(dateStr);
  const days = Math.round((d - zeroDate) / 86400000);
  return Math.max(0, Math.round(days / STEP_DAYS));
}

function range(start, stop) {
  const out = [];
  for (let i = start; i < stop; i++) out.push(i);
  return out;
}
