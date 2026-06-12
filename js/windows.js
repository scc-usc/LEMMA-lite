// 4. WINDOW / LOOKBACK COMPUTATION (in timesteps)
// ============================================================
//
// Everything is in TIMESTEPS — one step = one data point (a week or a day, per the
// granularity setting; the algorithm is unit-agnostic). An "origin" is the index of
// the last observed step used to make a forecast. A "lookback" lb is how many steps
// are held back from the end:
//
//   lb = (nSteps - 1) - origin        cutLen (steps used) = nSteps - lb
//
// so lb = 0 forecasts from the most recent step. The training window and the forecast
// origin range are BOTH chosen by the user (the two sliders under the plot). If they
// overlap, training targets may coincide with the forecast period (leakage) — that is
// the user's choice; nothing is masked here.

// Minimum number of data points (timesteps) of history before the earliest training
// origin, so it still has enough past data to form the forecaster inputs.
const MIN_HISTORY_STEPS = 8;

// Default length (in timesteps) of the training window the sliders open to.
const DEFAULT_TRAIN_STEPS = 52;

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
//   training window  = last DEFAULT_TRAIN_STEPS data points if available, else from
//                      the warm-up start (>= MIN_HISTORY_STEPS) .. last observed step
//   forecast origins = last observed step .. last observed step
function defaultWindows(nSteps) {
  const maxOrigin = Math.max(0, nSteps - 1);
  const startTrain = Math.min(maxOrigin, Math.max(MIN_HISTORY_STEPS, maxOrigin - (DEFAULT_TRAIN_STEPS - 1)));
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
