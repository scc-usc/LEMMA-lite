// 7. BASIC ENSEMBLE
// ============================================================

// Xw: (weeksAhead, nScen) - weekly counts per scenario
// Returns: (weeksAhead, nQuantiles)
function basicEnsemblePredict(Xw, quantiles) {
  const weeksAhead = Xw.length;
  const nQ = quantiles.length;
  const out = Array.from({ length: weeksAhead }, () => new Float64Array(nQ));
  for (let w = 0; w < weeksAhead; w++) {
    const vals = Xw[w];
    for (let qi = 0; qi < nQ; qi++) out[w][qi] = computeQuantile(vals, quantiles[qi]);
  }
  return out;
}

// ============================================================
// 8. QUANTILE RANDOM FOREST
// ============================================================

class CARTNode {
  constructor(y) { this.isLeaf = true; this.y = y; }
}

class CARTTree {
  constructor(maxDepth = 6, minLeaf = 5) {
    this.maxDepth = maxDepth; this.minLeaf = minLeaf; this.root = null;
  }

  fit(X, y, indices) {
    this.root = this._split(X, y, indices, 0);
  }

  _split(X, y, indices, depth) {
    const n = indices.length;
    const leafY = indices.map(i => y[i]);
    if (depth >= this.maxDepth || n < 2 * this.minLeaf) {
      const node = new CARTNode(leafY); return node;
    }
    const p = X[0].length;
    // sqrt(p) random features
    const nTry = Math.max(1, Math.round(Math.sqrt(p)));
    const feats = shuffleArray([...Array(p).keys()]).slice(0, nTry);

    let bestGain = -Infinity, bestF = -1, bestT = 0;
    let bestL = null, bestR = null;
    const parentMSE = mse1D(leafY);

    for (const f of feats) {
      const vals = indices.map(i => X[i][f]);
      const sortedVals = [...new Set(vals)].sort((a, b) => a - b);
      // Limit candidates to 10
      const step = Math.max(1, Math.floor(sortedVals.length / 10));
      for (let vi = 0; vi < sortedVals.length - 1; vi += step) {
        const thresh = (sortedVals[vi] + sortedVals[vi + 1]) / 2;
        const L = indices.filter(i => X[i][f] <= thresh);
        const R = indices.filter(i => X[i][f] > thresh);
        if (L.length < this.minLeaf || R.length < this.minLeaf) continue;
        const gain = parentMSE
          - (L.length / n) * mse1D(L.map(i => y[i]))
          - (R.length / n) * mse1D(R.map(i => y[i]));
        if (gain > bestGain) { bestGain = gain; bestF = f; bestT = thresh; bestL = L; bestR = R; }
      }
    }

    if (bestF === -1) { const node = new CARTNode(leafY); return node; }
    return {
      isLeaf: false, feature: bestF, threshold: bestT,
      left: this._split(X, y, bestL, depth + 1),
      right: this._split(X, y, bestR, depth + 1),
    };
  }

  getLeafY(x) {
    let node = this.root;
    while (!node.isLeaf) node = x[node.feature] <= node.threshold ? node.left : node.right;
    return node.y;
  }
}

class QuantileForest {
  constructor(nTrees = 30, maxDepth = 6, minLeaf = 5) {
    this.nTrees = nTrees; this.maxDepth = maxDepth; this.minLeaf = minLeaf;
    this.trees = [];
  }

  // weights (optional): per-sample bootstrap probabilities (e.g. recency decay).
  fit(X, y, weights) {
    this.trees = [];
    const n = X.length;
    const sample = makeWeightedSampler(n, weights);
    for (let t = 0; t < this.nTrees; t++) {
      const bootstrap = Array.from({ length: n }, () => sample());
      const tree = new CARTTree(this.maxDepth, this.minLeaf);
      tree.fit(X, y, bootstrap);
      this.trees.push(tree);
    }
  }

  predictQuantile(x, q) {
    const allY = [];
    for (const tree of this.trees) for (const v of tree.getLeafY(x)) allY.push(v);
    if (!allY.length) return 0;
    allY.sort((a, b) => a - b);
    const idx = Math.min(Math.floor(q * allY.length), allY.length - 1);
    return allY[idx];
  }
}

// Returns a function that draws an index in [0, n) — uniformly if no weights are
// given, otherwise with probability proportional to weights (via inverse-CDF).
function makeWeightedSampler(n, weights) {
  if (!weights || weights.length !== n) return () => Math.floor(Math.random() * n);
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += Math.max(0, weights[i]); cdf[i] = acc; }
  if (acc <= 0) return () => Math.floor(Math.random() * n);
  return () => {
    const r = Math.random() * acc;
    // binary search for the first cdf >= r
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  };
}

// Pick `k` distinct indices uniformly at random from [0, n) via a partial
// Fisher-Yates shuffle. Returns all n indices (shuffled) if k >= n.
function sampleIndices(n, k) {
  const idx = [...Array(n).keys()];
  const m = Math.min(k, n);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, m);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
