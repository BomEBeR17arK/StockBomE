/* ============================================================
   StockBomE — indicators.js
   ------------------------------------------------------------
   Pure-JS technical indicator math, no external libraries.
   All functions take arrays of numbers (which may contain
   `null` for missing/insufficient data) and return arrays of
   the SAME LENGTH, with `null` in positions where there isn't
   enough history yet to compute a value.

   Exposed on `window.*` so app.js (loaded after this file) can
   call them directly without a module system / build step.
   ============================================================ */

/**
 * Exponential Moving Average.
 * Seeded with the SMA of the first `period` values (standard
 * practice — avoids a noisy "start from first sample" seed).
 * First (period-1) values are null.
 * @param {(number|null)[]} arr
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calcEMA(arr, period) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;

  const k = 2 / (period + 1);
  let seedSum = 0, seedCount = 0, seeded = false, prev = null;

  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (!seeded) {
      if (v == null) continue; // skip leading nulls when accumulating the seed window
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
        seeded = true;
      }
      continue;
    }
    if (v == null) { out[i] = prev; continue; } // hold last value through gaps
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Simple Moving Average. First (period-1) values are null.
 * @param {(number|null)[]} arr
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calcSMA(arr, period) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;

  let windowSum = 0;
  let validCount = 0;
  const buf = [];
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    buf.push(v);
    if (v != null) { windowSum += v; validCount++; }
    if (buf.length > period) {
      const removed = buf.shift();
      if (removed != null) { windowSum -= removed; validCount--; }
    }
    if (buf.length === period && validCount === period) {
      out[i] = windowSum / period;
    }
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing.
 * First `period` values are null (RSI needs `period` deltas,
 * i.e. period+1 closes, to produce its first reading).
 * @param {(number|null)[]} arr
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calcRSI(arr, period = 14) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;

  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prevV = arr[i - 1], v = arr[i];
    if (prevV == null || v == null) continue;
    const delta = v - prevV;
    gains[i] = Math.max(delta, 0);
    losses[i] = Math.max(-delta, 0);
  }

  let avgGain = null, avgLoss = null;
  for (let i = 1; i < n; i++) {
    if (avgGain == null) {
      if (i < period) continue; // need `period` deltas (indices 1..period)
      let gSum = 0, lSum = 0;
      for (let j = i - period + 1; j <= i; j++) { gSum += gains[j]; lSum += losses[j]; }
      avgGain = gSum / period;
      avgLoss = lSum / period;
    } else {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

/**
 * MACD (Moving Average Convergence Divergence).
 * @param {(number|null)[]} arr
 * @param {number} fast
 * @param {number} slow
 * @param {number} signalPeriod
 * @returns {{macd:(number|null)[], signal:(number|null)[], histogram:(number|null)[]}}
 */
function calcMACD(arr, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calcEMA(arr, fast);
  const emaSlow = calcEMA(arr, slow);
  const macd = arr.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null
  );
  const signal = calcEMA(macd, signalPeriod);
  const histogram = macd.map((v, i) =>
    (v != null && signal[i] != null) ? v - signal[i] : null
  );
  return { macd, signal, histogram };
}

/**
 * Bollinger Bands.
 * `middle` = SMA(period). `std` = rolling SAMPLE standard
 * deviation (ddof=1, matches pandas' default `.std()`).
 * @param {(number|null)[]} arr
 * @param {number} period
 * @param {number} numStd
 * @returns {{upper:(number|null)[], middle:(number|null)[], lower:(number|null)[]}}
 */
function calcBollinger(arr, period = 20, numStd = 2.0) {
  const n = arr.length;
  const middle = calcSMA(arr, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (middle[i] == null) continue;
    const win = arr.slice(i - period + 1, i + 1);
    if (win.some(v => v == null) || win.length < period) continue;
    const mean = middle[i];
    const variance = win.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (period - 1 || 1);
    const std = Math.sqrt(variance);
    upper[i] = mean + numStd * std;
    lower[i] = mean - numStd * std;
  }
  return { upper, middle, lower };
}

/**
 * On-Balance Volume.
 * direction[i] = sign(close[i]-close[i-1]); direction[0] = 0.
 * @param {(number|null)[]} close
 * @param {(number|null)[]} volume
 * @returns {number[]}
 */
function calcOBV(close, volume) {
  const n = close.length;
  const out = new Array(n).fill(0);
  let obv = 0;
  for (let i = 1; i < n; i++) {
    const c0 = close[i - 1], c1 = close[i], v = volume[i];
    if (c0 == null || c1 == null || v == null) { out[i] = obv; continue; }
    if (c1 > c0) obv += v;
    else if (c1 < c0) obv -= v;
    out[i] = obv;
  }
  return out;
}

/**
 * Rolling (anchored-window) Volume-Weighted Average Price.
 * NOTE: this app only has daily bars, so a classic *intraday session*
 * VWAP doesn't apply — this is a rolling VWAP over the trailing
 * `period` bars, which is the common adaptation used on daily/swing
 * charts (resets its window every bar rather than every session).
 * @param {(number|null)[]} high
 * @param {(number|null)[]} low
 * @param {(number|null)[]} close
 * @param {(number|null)[]} volume
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calcVWAP(high, low, close, volume, period = 20) {
  const n = close.length;
  const out = new Array(n).fill(null);
  const tpv = new Array(n).fill(0);   // typical-price * volume, per bar
  const vol = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (high[i] == null || low[i] == null || close[i] == null || volume[i] == null) continue;
    const tp = (high[i] + low[i] + close[i]) / 3;
    tpv[i] = tp * volume[i];
    vol[i] = volume[i];
  }

  let sumTPV = 0, sumVol = 0;
  const bufTPV = [], bufVol = [];
  for (let i = 0; i < n; i++) {
    bufTPV.push(tpv[i]); bufVol.push(vol[i]);
    sumTPV += tpv[i]; sumVol += vol[i];
    if (bufTPV.length > period) {
      sumTPV -= bufTPV.shift();
      sumVol -= bufVol.shift();
    }
    if (bufTPV.length === period && sumVol > 0) {
      out[i] = sumTPV / sumVol;
    }
  }
  return out;
}

/**
 * Average True Range (Wilder's smoothing) — a volatility measure
 * commonly used to size stop-losses (e.g. entry - 1.5*ATR).
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|).
 * First `period` values are null (needs `period` true-range samples).
 * @param {(number|null)[]} high
 * @param {(number|null)[]} low
 * @param {(number|null)[]} close
 * @param {number} period
 * @returns {(number|null)[]}
 */
function calcATR(high, low, close, period = 14) {
  const n = close.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;

  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (high[i] == null || low[i] == null || close[i - 1] == null) continue;
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
  }

  let avg = null;
  for (let i = 1; i < n; i++) {
    if (tr[i] == null) continue;
    if (avg == null) {
      if (i < period) continue;
      const win = tr.slice(i - period + 1, i + 1).filter(v => v != null);
      if (win.length < period) continue;
      avg = win.reduce((a, b) => a + b, 0) / period;
    } else {
      avg = (avg * (period - 1) + tr[i]) / period;
    }
    out[i] = avg;
  }
  return out;
}

/**
 * Key support/resistance levels from recent price action.
 * r2 = highest high in the lookback window.
 * r1 = the `topN`-th largest high (i.e. `nlargest(topN)` then take the smallest of that set).
 * s1 = the `topN`-th smallest low.
 * s2 = lowest low in the lookback window.
 * @param {(number|null)[]} high
 * @param {(number|null)[]} low
 * @param {(number|null)[]} close
 * @param {number} lookback
 * @param {number} topN
 * @returns {{r2:number|null, r1:number|null, s1:number|null, s2:number|null}}
 */
function findSupportResistance(high, low, close, lookback = 60, topN = 5) {
  const n = close.length;
  if (!n) return { r2: null, r1: null, s1: null, s2: null };
  const lb = Math.min(lookback, n);

  const hRecent = high.slice(n - lb).filter(v => v != null);
  const lRecent = low.slice(n - lb).filter(v => v != null);
  if (!hRecent.length || !lRecent.length) return { r2: null, r1: null, s1: null, s2: null };

  const hDesc = [...hRecent].sort((a, b) => b - a);
  const lAsc = [...lRecent].sort((a, b) => a - b);
  const idx = Math.min(topN, hDesc.length) - 1;
  const idxL = Math.min(topN, lAsc.length) - 1;

  return {
    r2: hDesc[0],
    r1: hDesc[idx],
    s1: lAsc[idxL],
    s2: lAsc[0],
  };
}

/**
 * Detect the standard "10-signal" set used across StockBomE,
 * evaluated at the LAST index of each series (i.e. "as of today").
 * Every flag degrades gracefully to `false` if the underlying
 * indicator doesn't have enough history yet.
 *
 * @param {(number|null)[]} close
 * @param {(number|null)[]} high
 * @param {(number|null)[]} low
 * @param {(number|null)[]} volume
 * @param {(number|null)[]} ema50
 * @param {(number|null)[]} ema200
 * @param {(number|null)[]} rsi
 * @param {{macd:(number|null)[], signal:(number|null)[]}} macd
 * @param {(number|null)[]} bbWidth  pre-computed (upper-lower)/middle*100 series
 * @returns {object} boolean flags, see below
 */
function detectSignals(close, high, low, volume, ema50, ema200, rsi, macd, bbWidth) {
  const n = close.length;
  const empty = {
    goldenCross: false, deathCross: false,
    emaBullish: false, emaBearish: false,
    rsiOversold: false, rsiOverbought: false,
    macdBullish: false, macdBearish: false,
    volumeSpike: false, breakout52w: false,
    bbSqueeze: false, bullZone: false,
  };
  if (n < 2) return empty;

  const li = n - 1, pi = n - 2;
  const lc = close[li];
  const le50 = ema50[li], pe50 = ema50[pi];
  const le200 = ema200[li], pe200 = ema200[pi];
  const lr = rsi[li];
  const lm = macd && macd.macd ? macd.macd[li] : null;
  const ls = macd && macd.signal ? macd.signal[li] : null;
  const pm = macd && macd.macd ? macd.macd[pi] : null;
  const ps = macd && macd.signal ? macd.signal[pi] : null;

  const goldenCross = !!(le50 != null && le200 != null && pe50 != null && pe200 != null && le50 > le200 && pe50 <= pe200);
  const deathCross = !!(le50 != null && le200 != null && pe50 != null && pe200 != null && le50 < le200 && pe50 >= pe200);
  // Persistent trend state (unlike goldenCross/deathCross, which only fire
  // on the single day the crossover happens) — stays true for as long as
  // the alignment holds, so the badge doesn't vanish the day after a cross.
  const emaBullish = !!(le50 != null && le200 != null && le50 > le200);
  const emaBearish = !!(le50 != null && le200 != null && le50 < le200);
  const rsiOversold = lr != null && lr < 30;
  const rsiOverbought = lr != null && lr > 70;
  const macdBullish = !!(lm != null && ls != null && pm != null && ps != null && lm > ls && pm <= ps);
  const macdBearish = !!(lm != null && ls != null && pm != null && ps != null && lm < ls && pm >= ps);

  const validVol = volume.filter(v => v != null);
  const avgVol = validVol.length ? validVol.reduce((a, b) => a + b, 0) / validVol.length : null;
  const lastVol = volume[li];
  const volumeSpike = !!(lastVol != null && avgVol && lastVol > avgVol * 2);

  const lookback52 = Math.min(252, n);
  const highWindow = high.slice(n - lookback52).filter(v => v != null);
  const h52 = highWindow.length ? Math.max(...highWindow) : null;
  const breakout52w = !!(lc != null && h52 != null && lc >= h52 * 0.99);

  let bbSqueeze = false;
  if (bbWidth && bbWidth[li] != null) {
    const win = bbWidth.slice(Math.max(0, li - 49), li + 1).filter(v => v != null);
    if (win.length) {
      const avgW = win.reduce((a, b) => a + b, 0) / win.length;
      bbSqueeze = avgW > 0 && bbWidth[li] < avgW * 0.5;
    }
  }

  const bullZone = !!(lc != null && le200 != null && lc > le200);

  return {
    goldenCross, deathCross, emaBullish, emaBearish,
    rsiOversold, rsiOverbought,
    macdBullish, macdBearish, volumeSpike, breakout52w,
    bbSqueeze, bullZone,
  };
}

// ---- expose on window (no module system / build step in this app) ----
window.calcEMA = calcEMA;
window.calcSMA = calcSMA;
window.calcRSI = calcRSI;
window.calcMACD = calcMACD;
window.calcBollinger = calcBollinger;
window.calcOBV = calcOBV;
window.calcVWAP = calcVWAP;
window.calcATR = calcATR;
window.findSupportResistance = findSupportResistance;
window.detectSignals = detectSignals;
