// 1. MATH UTILITIES
// ============================================================

// Days per analysis timestep. Set from the "Data Granularity" control: 7 for weekly
// (and daily-to-weekly, where daily rows are first aggregated into weeks) or 1 for
// daily. The only place steps touch calendar days is date parsing/labelling.
let STEP_DAYS = 7;

function cumsum1D(arr) {
  const out = new Float64Array(arr.length);
  let s = 0;
  for (let i = 0; i < arr.length; i++) { s += arr[i]; out[i] = s; }
  return out;
}

function cumsum2D(matrix) {
  return matrix.map(row => cumsum1D(row));
}

function diff1D(arr) {
  if (arr.length < 2) return new Float64Array(0);
  const out = new Float64Array(arr.length - 1);
  for (let i = 0; i < arr.length - 1; i++) out[i] = arr[i + 1] - arr[i];
  return out;
}

// diff on axis=2 of (nScen, nLoc, nTime) → (nScen, nLoc, nTime-1)
function diff3D(data) {
  return data.map(scenSlice => scenSlice.map(row => diff1D(row)));
}

// Least-squares via normal equations (X^T X) coef = X^T y, returns coef as Float64Array
function lstsq(X, y) {
  // X: (n, p), y: (n,)
  const n = X.length;
  const p = X[0].length;
  if (p === 0 || n <= p) return new Float64Array(p);
  // XtX = p×p, Xty = p
  const XtX = Array.from({ length: p }, () => new Float64Array(p));
  const Xty = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) XtX[j][k] += X[i][j] * X[i][k];
    }
  }
  // Tikhonov regularization (ridge) for stability
  const lambda = 1e-8;
  for (let j = 0; j < p; j++) XtX[j][j] += lambda;
  return solveLinearSystem(XtX, Xty, p);
}

// Gaussian elimination with partial pivoting
function solveLinearSystem(A, b, n) {
  const mat = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(mat[row][col]) > Math.abs(mat[maxRow][col])) maxRow = row;
    }
    [mat[col], mat[maxRow]] = [mat[maxRow], mat[col]];
    if (Math.abs(mat[col][col]) < 1e-14) continue;
    for (let row = col + 1; row < n; row++) {
      const f = mat[row][col] / mat[col][col];
      for (let j = col; j <= n; j++) mat[row][j] -= f * mat[col][j];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(mat[i][i]) < 1e-14) continue;
    x[i] = mat[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= mat[i][j] * x[j];
    x[i] /= mat[i][i];
  }
  return x;
}

function computeQuantile(arr, q) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean1D(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function mse1D(arr) {
  if (arr.length === 0) return 0;
  const m = mean1D(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}
