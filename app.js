/* ============================================================
   StockBomE — vanilla JS PWA stock volume-signal scanner
   No build step. No backend. All state in localStorage.
   ============================================================ */

const LS_KEYS = {
  scanList: "vs_scan_list",       // [{symbol, market}]
  watchlist: "vs_watchlist",      // [symbol]
  settings: "vs_settings",        // {earlyTh, strongTh, proxyUrl, defaultRange}
  chartToggles: "vs_chart_toggles", // {candle, ema, bb, volume, obv, rsi, macd}
  cache: "vs_cache_",             // vs_cache_<symbol> -> {ts, chart, fundamentals, signal, indicators}
};

const DEFAULT_CHART_TOGGLES = {
  candle: true, ema: true, bb: false, vwap: true, volume: true, obv: true, rsi: true, macd: true,
};

const DEFAULT_SETTINGS = {
  earlyTh: 1.5,
  strongTh: 2.5,
  proxyUrl: "https://corsproxy.io/?url=",
  defaultRange: "3mo",
};

const DEFAULT_SCAN_LIST = [
  { symbol: "PTT.BK", market: "SET" },
  { symbol: "AOT.BK", market: "SET" },
  { symbol: "CPALL.BK", market: "SET" },
  { symbol: "DELTA.BK", market: "SET" },
  { symbol: "ADVANC.BK", market: "SET" },
  { symbol: "SCB.BK", market: "SET" },
  { symbol: "KBANK.BK", market: "SET" },
  { symbol: "GULF.BK", market: "SET" },
  { symbol: "AAPL", market: "US" },
  { symbol: "NVDA", market: "US" },
  { symbol: "TSLA", market: "US" },
  { symbol: "MSFT", market: "US" },
];

// ---------------- state ----------------
let state = {
  settings: loadSettings(),
  scanList: loadJSON(LS_KEYS.scanList, DEFAULT_SCAN_LIST),
  watchlist: loadJSON(LS_KEYS.watchlist, []),
  chartToggles: Object.assign({}, DEFAULT_CHART_TOGGLES, loadJSON(LS_KEYS.chartToggles, {})),
  currentTab: "scanner",
  currentMarketFilter: "ALL",
  currentSymbol: null,
  currentRange: null,
  currentDetailData: null,
  isRefreshing: false,
};
state.currentRange = state.settings.defaultRange;
function saveChartToggles() { saveJSON(LS_KEYS.chartToggles, state.chartToggles); }

// ---------------- storage helpers ----------------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/unavailable */ }
}
function loadSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, loadJSON(LS_KEYS.settings, {}));
}
function saveSettings() { saveJSON(LS_KEYS.settings, state.settings); }
function saveScanList() { saveJSON(LS_KEYS.scanList, state.scanList); }
function saveWatchlist() { saveJSON(LS_KEYS.watchlist, state.watchlist); }

function getCache(symbol) { return loadJSON(LS_KEYS.cache + symbol, null); }
function setCache(symbol, data) {
  saveJSON(LS_KEYS.cache + symbol, Object.assign({ ts: Date.now() }, data));
}

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------------- data fetching ----------------
function buildProxied(url) {
  const p = state.settings.proxyUrl || "";
  if (!p) return url;
  if (p.includes("url=")) return p + encodeURIComponent(url);
  return p + url;
}

const PERIOD_DAYS = { "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365 };

async function fetchYahooChart(symbol, range, interval) {
  const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(buildProxied(yUrl));
  if (!res.ok) throw new Error("chart fetch failed: " + res.status);
  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error("no chart data");
  const ts = result.timestamp || [];
  const q = result.indicators.quote[0] || {};
  const meta = result.meta || {};
  return {
    meta,
    timestamps: ts,
    close: q.close || [],
    open: q.open || [],
    high: q.high || [],
    low: q.low || [],
    volume: q.volume || [],
  };
}

async function fetchChart(symbol) {
  // Always pull a full year of daily bars regardless of the display range —
  // EMA200 / 52-week breakout / etc. need the long history to be meaningful.
  // The display range selector only slices this same dataset for viewing.
  return fetchYahooChart(symbol, "1y", "1d");
}

// Weekly bars for a simple multi-timeframe confirmation check (see
// computeWeeklyBias). 2y of weekly bars gives enough history for a
// weekly EMA20/RSI14 reading.
async function fetchWeeklyChart(symbol) {
  return fetchYahooChart(symbol, "2y", "1wk");
}

async function fetchFundamentals(symbol) {
  const modules = "summaryDetail,defaultKeyStatistics,financialData,price";
  const yUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  const res = await fetch(buildProxied(yUrl));
  if (!res.ok) throw new Error("fundamentals fetch failed: " + res.status);
  const json = await res.json();
  const result = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!result) throw new Error("no fundamentals data");
  return result;
}

// Simple weekly bias: is price above/below its own 20-week EMA, and what's
// weekly RSI doing. Used only to flag daily-vs-weekly disagreement — this
// isn't meant to replace a real multi-timeframe analysis, just a quick
// "is the bigger trend fighting this daily signal?" sanity check.
function computeWeeklyBias(weeklyChart) {
  if (!weeklyChart || !weeklyChart.close || weeklyChart.close.length < 20) return null;
  const closes = weeklyChart.close;
  const ema20 = calcEMA(closes, 20);
  const rsi = calcRSI(closes, 14);
  const li = closes.length - 1;
  const lc = closes[li], le = ema20[li], lr = rsi[li];
  if (lc == null || le == null) return null;
  return {
    bias: lc > le ? "bullish" : "bearish",
    close: lc,
    ema20: le,
    rsi: lr,
  };
}

function rawNum(field) {
  if (field == null) return null;
  if (typeof field === "object" && "raw" in field) return field.raw;
  if (typeof field === "number") return field;
  return null;
}

// Compute volume signal from chart data
function computeSignal(chart) {
  const closes = chart.close, vols = chart.volume;
  let lastIdx = closes.length - 1;
  while (lastIdx > 0 && (closes[lastIdx] == null || vols[lastIdx] == null)) lastIdx--;
  if (lastIdx < 2) return null;

  const lastClose = closes[lastIdx];
  const lastVol = vols[lastIdx];

  let prevIdx = lastIdx - 1;
  while (prevIdx > 0 && closes[prevIdx] == null) prevIdx--;
  const prevClose = closes[prevIdx];

  const histStart = Math.max(0, lastIdx - 20);
  const histVols = [];
  for (let i = histStart; i < lastIdx; i++) {
    if (vols[i] != null) histVols.push(vols[i]);
  }
  const avgVol = histVols.length ? histVols.reduce((a, b) => a + b, 0) / histVols.length : null;
  const volRatio = avgVol ? lastVol / avgVol : null;
  const pctChange = prevClose ? ((lastClose - prevClose) / prevClose) * 100 : null;

  let level = "none";
  if (volRatio != null) {
    if (volRatio >= state.settings.strongTh) level = "strong";
    else if (volRatio >= state.settings.earlyTh) level = "early";
  }

  return { lastClose, lastVol, avgVol, volRatio, pctChange, level, direction: pctChange >= 0 ? "up" : "down" };
}

// Compute the full indicator bundle once, over the FULL fetched history.
// (Display-range slicing happens later, at render time — see sliceForDisplay.)
function computeIndicators(chart) {
  const { close, high, low, volume } = chart;
  const ema15 = calcEMA(close, 15);
  const ema50 = calcEMA(close, 50);
  const ema200 = calcEMA(close, 200);
  const rsi = calcRSI(close, 14);
  const macd = calcMACD(close, 12, 26, 9);
  const bollinger = calcBollinger(close, 20, 2.0);
  const obv = calcOBV(close, volume);
  const vwap = calcVWAP(high, low, close, volume, 20);
  const atr = calcATR(high, low, close, 14);
  const supportResistance = findSupportResistance(high, low, close, 60, 5);

  const bbWidth = bollinger.upper.map((u, i) => {
    const l = bollinger.lower[i], m = bollinger.middle[i];
    return (u != null && l != null && m) ? ((u - l) / m) * 100 : null;
  });

  const signals = detectSignals(close, high, low, volume, ema50, ema200, rsi, macd, bbWidth);

  return { ema15, ema50, ema200, rsi, macd, bollinger, bbWidth, obv, vwap, atr, supportResistance, signals };
}

// Slice both the raw chart and its pre-computed indicators to the same
// tail window for display, without recomputing anything (EMA/RSI/etc.
// were already computed on the full 1y series so long-lookback values
// stay accurate right up to the edge of the visible window).
function sliceForDisplay(chart, ind, rangeKey) {
  const ts = chart.timestamps;
  const n = ts.length;
  if (!n) return { chart, ind };

  const days = PERIOD_DAYS[rangeKey] || 90;
  const lastTs = ts[n - 1];
  const cutoff = lastTs - days * 86400;
  let start = 0;
  while (start < n && ts[start] < cutoff) start++;
  if (start >= n) start = Math.max(0, n - 1);

  const cut = (arr) => (Array.isArray(arr) ? arr.slice(start) : arr);
  const slicedChart = {
    meta: chart.meta,
    timestamps: cut(ts),
    close: cut(chart.close),
    open: cut(chart.open),
    high: cut(chart.high),
    low: cut(chart.low),
    volume: cut(chart.volume),
  };
  const slicedInd = {
    ema15: cut(ind.ema15),
    ema50: cut(ind.ema50),
    ema200: cut(ind.ema200),
    rsi: cut(ind.rsi),
    macd: { macd: cut(ind.macd.macd), signal: cut(ind.macd.signal), histogram: cut(ind.macd.histogram) },
    bollinger: { upper: cut(ind.bollinger.upper), middle: cut(ind.bollinger.middle), lower: cut(ind.bollinger.lower) },
    bbWidth: cut(ind.bbWidth),
    obv: cut(ind.obv),
    vwap: cut(ind.vwap),
    atr: cut(ind.atr),
    supportResistance: ind.supportResistance, // computed over its own 60-bar lookback, not sliced
    signals: ind.signals,                     // always reflects the latest full-history reading
  };
  return { chart: slicedChart, ind: slicedInd };
}

// Load (from cache first, then network) a full symbol record.
// Cache is no longer keyed by display range — we always fetch/keep the
// full 1y series and slice client-side for whichever range is selected.
async function loadSymbolData(symbol, { forceNetwork = false } = {}) {
  const cached = getCache(symbol);
  const fresh = cached && (Date.now() - cached.ts < 5 * 60 * 1000);
  if (fresh && !forceNetwork) return { data: cached, fromCache: true };

  try {
    const [chart, fundamentals, weeklyChart] = await Promise.all([
      fetchChart(symbol),
      fetchFundamentals(symbol).catch(() => null),
      fetchWeeklyChart(symbol).catch(() => null),
    ]);
    const signal = computeSignal(chart);
    const indicators = computeIndicators(chart);
    const weeklyBias = computeWeeklyBias(weeklyChart);
    const record = { chart, fundamentals, signal, indicators, weeklyBias };
    setCache(symbol, record);
    return { data: Object.assign({ ts: Date.now() }, record), fromCache: false };
  } catch (err) {
    if (cached) return { data: cached, fromCache: true, stale: true, error: err };
    throw err;
  }
}

// ---------------- formatting ----------------
function fmtPrice(v, symbol) {
  if (v == null || isNaN(v)) return "—";
  const isSet = symbol && symbol.endsWith(".BK");
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (isSet ? " ฿" : " $");
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return s + v.toFixed(2) + "%";
}
function fmtVol(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}
function fmtRatio(v) {
  if (v == null || isNaN(v)) return "—";
  return v.toFixed(2) + "x";
}
function fmtBig(v) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  return v.toLocaleString();
}
function fmtPlain2(v) { return v == null || isNaN(v) ? "—" : v.toFixed(2); }
function fmtPercentField(v) { return v == null || isNaN(v) ? "—" : (v * 100).toFixed(2) + "%"; }
function timeAgo(ts) {
  if (!ts) return "ยังไม่เคยอัปเดต";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "อัปเดตล่าสุด: เมื่อสักครู่";
  if (s < 3600) return `อัปเดตล่าสุด: ${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `อัปเดตล่าสุด: ${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  return `อัปเดตล่าสุด: ${Math.floor(s / 86400)} วันที่แล้ว`;
}

// ---------------- rendering: scanner & watchlist cards ----------------
function signalBadgeHtml(sig) {
  if (!sig || sig.level === "none") return "";
  const label = sig.level === "strong" ? "สัญญาณชัดเจน" : "เริ่มเห็นสัญญาณ";
  const dirClass = sig.direction === "down" ? " down" : "";
  return `<span class="signal-badge ${sig.level}${dirClass}">${label} ${fmtRatio(sig.volRatio)}</span>`;
}

function stockCardHtml(symbol, market, record, opts = {}) {
  const sig = record && record.signal;
  const chg = sig ? sig.pctChange : null;
  const chgClass = chg == null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
  const price = sig ? sig.lastClose : null;
  const removeBtn = opts.removable
    ? `<button class="remove-x" data-remove="${symbol}" data-list="${opts.removable}">✕</button>`
    : "";
  return `
  <div class="stock-card" data-symbol="${symbol}">
    <div class="left">
      <div class="ticker-row">
        <span class="ticker mono">${symbol.replace(".BK", "")}</span>
        <span class="market-tag">${market}</span>
      </div>
      <div class="sub">${sig ? "ปริมาณ " + fmtVol(sig.lastVol) + " · เฉลี่ย " + fmtVol(sig.avgVol) : "กำลังโหลด…"}</div>
      ${signalBadgeHtml(sig)}
    </div>
    <div class="right">
      <div class="price mono">${fmtPrice(price, symbol)}</div>
      <div class="chg mono ${chgClass}">${fmtPct(chg)}</div>
    </div>
    ${removeBtn}
  </div>`;
}

function marketOf(symbol) { return symbol.endsWith(".BK") ? "SET" : "US"; }

async function renderScannerInner() {
  const listEl = document.getElementById("scannerList");
  const emptyEl = document.getElementById("scannerEmpty");
  let items = state.scanList.filter(it =>
    state.currentMarketFilter === "ALL" || it.market === state.currentMarketFilter
  );

  if (items.length === 0) {
    listEl.innerHTML = "";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  const records = {};
  for (const it of items) records[it.symbol] = getCache(it.symbol);
  paintScannerList(items, records);

  await Promise.all(items.map(async (it) => {
    try {
      const { data } = await loadSymbolData(it.symbol);
      records[it.symbol] = data;
    } catch (e) { /* keep whatever cache we had */ }
  }));
  paintScannerList(items, records);
  updateHeaderMeta();
}

function paintScannerList(items, records) {
  const listEl = document.getElementById("scannerList");
  const sorted = items.slice().sort((a, b) => {
    const ra = (records[a.symbol] && records[a.symbol].signal && records[a.symbol].signal.volRatio) || 0;
    const rb = (records[b.symbol] && records[b.symbol].signal && records[b.symbol].signal.volRatio) || 0;
    return rb - ra;
  });
  listEl.innerHTML = sorted.map(it =>
    stockCardHtml(it.symbol, it.market, records[it.symbol], { removable: "scan" })
  ).join("");
}

function renderSuggestChips() {
  const row = document.getElementById("suggestRow");
  const already = new Set(state.scanList.map(it => it.symbol));
  const suggestions = DEFAULT_SCAN_LIST.filter(it => !already.has(it.symbol)).slice(0, 6);
  row.innerHTML = suggestions.map(it =>
    `<button class="chip-btn" data-symbol="${it.symbol}">+ ${it.symbol.replace(".BK", "")}</button>`
  ).join("");
}

async function renderScanner() {
  renderSuggestChips();
  await renderScannerInner();
}

function renderWatchlist() {
  const listEl = document.getElementById("watchlistList");
  const emptyEl = document.getElementById("watchlistEmpty");
  if (state.watchlist.length === 0) {
    listEl.innerHTML = "";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  const records = {};
  state.watchlist.forEach(sym => records[sym] = getCache(sym));
  listEl.innerHTML = state.watchlist.map(sym =>
    stockCardHtml(sym, marketOf(sym), records[sym], { removable: "watch" })
  ).join("");

  state.watchlist.forEach(async (sym) => {
    try {
      const { data } = await loadSymbolData(sym);
      const card = listEl.querySelector(`[data-symbol="${CSS.escape(sym)}"]`);
      if (card) card.outerHTML = stockCardHtml(sym, marketOf(sym), data, { removable: "watch" });
    } catch (e) {}
  });
}

function updateHeaderMeta() {
  const allTs = state.scanList
    .map(it => { const c = getCache(it.symbol); return c ? c.ts : 0; })
    .filter(Boolean);
  const latest = allTs.length ? Math.max(...allTs) : null;
  document.getElementById("lastUpdateChip").textContent = timeAgo(latest);
}

// ---------------- detail view ----------------
async function openDetail(symbol) {
  if (state.currentSymbol !== symbol) state.currentDetailTab = "chart";
  state.currentSymbol = symbol;
  switchTab("detail", true);
  const container = document.getElementById("detailContent");
  container.innerHTML = `<div class="empty-state"><div class="glyph">⏳</div><p>กำลังโหลดข้อมูล ${symbol}…</p></div>`;

  let data, fromCache = false, stale = false;
  try {
    const res = await loadSymbolData(symbol, { forceNetwork: false });
    data = res.data; fromCache = res.fromCache; stale = res.stale;
  } catch (e) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="glyph">⚠️</div>
        <p>ดึงข้อมูล ${symbol} ไม่สำเร็จ</p>
        <p style="font-size:12px;">ตรวจสอบสัญญาณอินเทอร์เน็ต หรือลองเปลี่ยน CORS proxy ในหน้าตั้งค่า</p>
      </div>`;
    return;
  }
  renderDetail(symbol, data, { fromCache, stale });
}

// ---------------- ratio interpretation (rule-of-thumb, educational only) ----------------
function interpretVolSignal(sig) {
  if (!sig || sig.level === "none") {
    return "ปริมาณซื้อขายล่าสุดยังอยู่ในช่วงปกติเมื่อเทียบกับค่าเฉลี่ย 20 วัน";
  }
  const dirTxt = sig.direction === "up" ? "ราคาปรับขึ้น" : "ราคาปรับลง";
  if (sig.level === "strong") {
    return `ปริมาณซื้อขายสูงกว่าค่าเฉลี่ย 20 วันถึง ${fmtRatio(sig.volRatio)} พร้อม${dirTxt} — เป็นสัญญาณผิดปกติที่ชัดเจน มักบ่งชี้ว่ามีความสนใจซื้อขายเพิ่มขึ้นมาก ควรตรวจสอบข่าวหรือปัจจัยที่เกี่ยวข้องประกอบ`;
  }
  return `ปริมาณซื้อขายเริ่มสูงกว่าปกติ (${fmtRatio(sig.volRatio)} ของค่าเฉลี่ย) พร้อม${dirTxt} — อาจเป็นสัญญาณเริ่มต้นของความเคลื่อนไหว ควรติดตามต่อเนื่อง`;
}
function interpretPE(v) {
  if (v == null) return "ไม่มีข้อมูล (อาจเป็นเพราะบริษัทขาดทุน หรือแหล่งข้อมูลไม่มีค่านี้)";
  if (v <= 0) return "ค่าติดลบ มักหมายถึงบริษัทขาดทุนในรอบล่าสุด";
  if (v < 10) return "ต่ำเมื่อเทียบกับตลาดโดยรวม อาจแปลว่าราคาถูก หรือตลาดมองว่าการเติบโตในอนาคตจำกัด";
  if (v < 20) return "อยู่ในช่วงปานกลาง ใกล้เคียงค่าเฉลี่ยของหุ้นทั่วไป";
  if (v < 35) return "ค่อนข้างสูง ตลาดอาจคาดหวังการเติบโตของกำไรในอนาคต";
  return "สูงมาก ตลาดคาดหวังการเติบโตสูง หรือราคาอาจตึงตัวเมื่อเทียบกับกำไรปัจจุบัน";
}
function interpretPB(v) {
  if (v == null) return "ไม่มีข้อมูล";
  if (v < 1) return "ต่ำกว่ามูลค่าทางบัญชี อาจบ่งชี้ว่าราคาถูก หรือตลาดกังวลปัจจัยพื้นฐานบางอย่าง";
  if (v < 3) return "อยู่ในช่วงปกติทั่วไปของหุ้นส่วนใหญ่";
  return "ค่อนข้างสูง มักพบในหุ้นกลุ่มเติบโตหรือมีสินทรัพย์ไม่จับต้องได้มาก";
}
function interpretROE(v) {
  if (v == null) return "ไม่มีข้อมูล";
  const pct = v * 100;
  if (pct < 0) return "ติดลบ บริษัทขาดทุนในรอบล่าสุด";
  if (pct < 10) return "ค่อนข้างต่ำ ประสิทธิภาพการใช้ส่วนของผู้ถือหุ้นทำกำไรยังไม่โดดเด่น";
  if (pct < 20) return "อยู่ในเกณฑ์ดี ใกล้เคียงค่าเฉลี่ยของบริษัทที่มีผลดำเนินงานแข็งแรง";
  return "สูง บ่งชี้ประสิทธิภาพการทำกำไรจากส่วนของผู้ถือหุ้นที่ดีมาก (ควรเช็คว่ามาจากหนี้สินสูงเกินไปหรือไม่)";
}
function interpretDE(v) {
  if (v == null) return "ไม่มีข้อมูล";
  if (v < 50) return "หนี้สินต่ำเมื่อเทียบกับทุน ความเสี่ยงทางการเงินค่อนข้างต่ำ";
  if (v < 100) return "อยู่ในระดับปานกลาง ใกล้เคียงหนี้สินเท่าทุน";
  if (v < 200) return "ค่อนข้างสูง ควรพิจารณาความสามารถในการชำระหนี้ประกอบ";
  return "สูงมาก มีความเสี่ยงทางการเงินจากภาระหนี้ที่ควรพิจารณาอย่างรอบคอบ";
}
function interpretDivYield(v) {
  if (v == null) return "ไม่มีข้อมูล หรือบริษัทไม่จ่ายปันผล";
  const pct = v * 100;
  if (pct < 1.5) return "ต่ำ เน้นการเติบโตของราคามากกว่ากระแสเงินสดจากปันผล";
  if (pct < 4) return "อยู่ในระดับปานกลาง ใกล้เคียงค่าเฉลี่ยตลาด";
  return "สูง ควรตรวจสอบว่าบริษัทมีความสามารถจ่ายปันผลต่อเนื่องได้จริงหรือไม่ (payout ratio สูงเกินไปหรือไม่)";
}

function ratioRow(label, value, interpretation) {
  return `
    <div class="ratio-row">
      <div class="ratio-row-top">
        <span class="k">${label}</span>
        <span class="v mono">${value}</span>
      </div>
      <div class="ratio-note">${interpretation}</div>
    </div>`;
}

// ---------------- detail view: sub-tabs ----------------
const DETAIL_TABS = [
  { id: "chart", label: "กราฟ" },
  { id: "financials", label: "งบการเงิน" },
  { id: "dividend", label: "ปันผล" },
  { id: "dw", label: "DW" },
];

function renderDetail(symbol, data, flags) {
  state.currentDetailData = data;
  state.currentDetailFlags = flags;
  state.currentDetailTab = state.currentDetailTab || "chart";

  const container = document.getElementById("detailContent");
  const sig = data.signal;
  const chg = sig ? sig.pctChange : null;
  const chgClass = chg == null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
  const meta = (data.chart && data.chart.meta) || {};
  const name = meta.longName || meta.shortName || "";
  const inWatch = state.watchlist.includes(symbol);

  container.innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="mono">${symbol.replace(".BK", "")}</h2>
        <div class="name">${name || marketOf(symbol)}</div>
      </div>
    </div>
    <div class="detail-price mono">${fmtPrice(sig ? sig.lastClose : null, symbol)}</div>
    <div class="detail-chg mono ${chgClass}">${fmtPct(chg)} ${signalBadgeHtml(sig)}</div>

    ${flags.stale ? `<div class="stale-note">⚠️ แสดงข้อมูลแคชล่าสุด (ดึงข้อมูลใหม่ไม่สำเร็จ)</div>` : ""}
    ${flags.fromCache && !flags.stale ? `<div class="offline-note">แสดงข้อมูลที่แคชไว้ (${timeAgo(data.ts)})</div>` : ""}

    <button class="watchlist-toggle ${inWatch ? "on" : ""}" id="watchToggleBtn">
      ${inWatch ? "★ อยู่ในรายการติดตามแล้ว" : "☆ เพิ่มในรายการติดตาม"}
    </button>

    <div class="detail-tabs" id="detailTabs">
      ${DETAIL_TABS.map(t => `<button data-tab="${t.id}" class="${t.id === state.currentDetailTab ? "active" : ""}">${t.label}</button>`).join("")}
    </div>

    <div id="detailTabContent"></div>
  `;

  document.getElementById("watchToggleBtn").onclick = () => toggleWatch(symbol);
  document.getElementById("detailTabs").querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      document.getElementById("detailTabs").querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderDetailTab(symbol, btn.dataset.tab);
    };
  });

  renderDetailTab(symbol, state.currentDetailTab);
}

function renderDetailTab(symbol, tab) {
  state.currentDetailTab = tab;
  if (tab === "chart") renderDetailTabChart(symbol);
  else if (tab === "financials") renderDetailTabFinancials(symbol);
  else if (tab === "dividend") renderDetailTabDividend(symbol);
  else if (tab === "dw") renderDetailTabDW(symbol);
}

// ---------------- signal badges + composite score ----------------
const SIGNAL_DEFS = [
  { key: "goldenCross", icon: "🌟", label: "Golden Cross (เพิ่งตัดขึ้น)", type: "bull" },
  { key: "deathCross", icon: "💀", label: "Death Cross (เพิ่งตัดลง)", type: "bear" },
  { key: "emaBullish", icon: "📶", label: "แนวโน้ม EMA ขาขึ้น", type: "bull" },
  { key: "emaBearish", icon: "📶", label: "แนวโน้ม EMA ขาลง", type: "bear" },
  { key: "rsiOversold", icon: "📉", label: "RSI Oversold", type: "bull" },
  { key: "rsiOverbought", icon: "📈", label: "RSI Overbought", type: "bear" },
  { key: "macdBullish", icon: "⚡", label: "MACD Bullish", type: "bull" },
  { key: "macdBearish", icon: "🔻", label: "MACD Bearish", type: "bear" },
  { key: "volumeSpike", icon: "🔊", label: "Volume Spike", type: "neu" },
  { key: "breakout52w", icon: "🚀", label: "52W Breakout", type: "bull" },
  { key: "bbSqueeze", icon: "🔗", label: "BB Squeeze", type: "neu" },
  { key: "bullZone", icon: "🐂", label: "Bull Zone", type: "bull" },
];

function signalBadgesHtml(signals) {
  const active = SIGNAL_DEFS.filter(s => signals && signals[s.key]);
  if (!active.length) return `<div class="ratio-note">ไม่มีสัญญาณเด่นในขณะนี้</div>`;
  return `<div class="signal-badges">` +
    active.map(s => `<span class="sig-badge sig-${s.type}">${s.icon} ${s.label}</span>`).join("") +
    `</div>`;
}

// Aggregate buy-volume % over the last `lookback` bars, using the same
// (close-low)/(high-low) split used per-bar in the volume panel.
function computeBuyPct(chart, lookback = 20) {
  const { high, low, close, volume } = chart;
  const n = close.length;
  const start = Math.max(0, n - lookback);
  let buy = 0, total = 0;
  for (let i = start; i < n; i++) {
    if (high[i] == null || low[i] == null || close[i] == null || volume[i] == null) continue;
    const hl = high[i] - low[i];
    const bv = hl > 0 ? volume[i] * ((close[i] - low[i]) / hl) : volume[i] / 2;
    buy += bv;
    total += volume[i];
  }
  return total > 0 ? (buy / total) * 100 : null;
}

// Composite -8..+8 style score, adapted from the market_terminal_v10
// scoring model to the data this app has on hand (buyPct/bbPct computed
// locally since there's no server-side pandas here).
function computeScore(sig, ind, chart) {
  const n = chart.close.length;
  const li = n - 1;
  if (li < 0) return 0;
  const lc = chart.close[li];
  const lrsi = ind.rsi[li];
  const lm = ind.macd.macd[li], ls = ind.macd.signal[li];
  const latr = ind.atr ? ind.atr[li] : null;
  const le15 = ind.ema15[li], le50 = ind.ema50[li], le200 = ind.ema200[li];
  const volRatio = sig ? sig.volRatio : null;
  const obvUp = (ind.obv[li] != null && ind.obv[li - 1] != null) ? ind.obv[li] > ind.obv[li - 1] : false;
  const buyPct = computeBuyPct(chart, 20);
  const bu = ind.bollinger.upper[li], bl = ind.bollinger.lower[li];
  const bbPct = (bu != null && bl != null && bu !== bl && lc != null) ? ((lc - bl) / (bu - bl)) * 100 : null;

  let score = 0;
  // RSI & MACD contribute continuously (scaled -1..+1) rather than a flat
  // ±1 step, so e.g. RSI 8 (deeply oversold) counts for more than RSI 29
  // (barely oversold) — magnitude, not just which side of the line it's on.
  if (lrsi != null) {
    score += clamp((50 - lrsi) / 50, -1, 1);
  }
  if (lm != null && ls != null) {
    const scale = (latr && latr > 0) ? latr : (Math.abs(lc || 1) * 0.01);
    score += clamp((lm - ls) / (scale || 1), -1, 1);
  }
  if (lc != null && le15 != null) score += lc > le15 ? 1 : 0;
  if (lc != null && le50 != null) score += lc > le50 ? 1 : 0;
  if (lc != null && le200 != null) score += lc > le200 ? 1 : 0;
  if (volRatio != null && volRatio > 1.5) score += 1;
  if (obvUp) score += 1;
  if (buyPct != null) score += buyPct > 55 ? 1 : (buyPct < 45 ? -1 : 0);
  if (bbPct != null) score += bbPct < 30 ? 1 : (bbPct > 70 ? -1 : 0);
  return score;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getVerdict(score) {
  if (score >= 6) return { label: "STRONG BUY 🚀", color: "#3fb950" };
  if (score >= 3) return { label: "BUY 📈", color: "#56d364" };
  if (score >= 0) return { label: "HOLD ⏸", color: "#e3b341" };
  if (score >= -2) return { label: "SELL 📉", color: "#f85149" };
  return { label: "STRONG SELL 🔻", color: "#ff3333" };
}

// ---------------- chart toggles ----------------
const TOGGLE_DEFS = [
  { key: "candle", label: "แท่งเทียน" },
  { key: "ema", label: "EMA" },
  { key: "bb", label: "BB" },
  { key: "vwap", label: "VWAP" },
  { key: "volume", label: "Volume" },
  { key: "obv", label: "OBV" },
  { key: "rsi", label: "RSI" },
  { key: "macd", label: "MACD" },
];
// Only toggles that own a dedicated <div id="panel-…"> get shown/hidden as
// a whole container. "candle" / "ema" / "bb" / "vwap" are all layers drawn
// inside the SAME price-panel canvas — toggling one off must not hide the
// other two, so the price panel's own visibility is handled separately
// (see applyPanelVisibility: it's visible whenever any of those 4 is on).
const TOGGLE_PANEL_ID = { volume: "panel-volume", obv: "panel-obv", rsi: "panel-rsi", macd: "panel-macd" };
const PRICE_PANEL_LAYER_TOGGLES = ["candle", "ema", "bb", "vwap"];

function toggleButtonsHtml() {
  return `<div class="chart-toggles" id="chartToggles">` +
    TOGGLE_DEFS.map(t =>
      `<button data-toggle="${t.key}" class="toggle-btn ${state.chartToggles[t.key] ? "active" : ""}">${t.label}</button>`
    ).join("") +
    `</div>`;
}

function applyPanelVisibility() {
  Object.entries(TOGGLE_PANEL_ID).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = state.chartToggles[key] ? "" : "none";
  });
  const priceEl = document.getElementById("panel-candle");
  if (priceEl) {
    const anyLayerOn = PRICE_PANEL_LAYER_TOGGLES.some(k => state.chartToggles[k]);
    priceEl.style.display = anyLayerOn ? "" : "none";
  }
}

function renderDetailTabChart(symbol) {
  const data = state.currentDetailData;
  const sig = data.signal;
  const chgClass = sig && sig.pctChange != null ? (sig.pctChange > 0 ? "up" : sig.pctChange < 0 ? "down" : "flat") : "flat";
  const f = data.fundamentals || {};
  const summaryDetail = f.summaryDetail || {};
  const keyStats = f.defaultKeyStatistics || {};

  const hasChart = data.chart && data.chart.close && data.chart.close.length;
  const ind = data.indicators;
  const score = hasChart && ind ? computeScore(sig, ind, data.chart) : 0;
  const verdict = getVerdict(score);

  // ATR-based stop-loss context (not investment advice — just a common
  // volatility-sizing rule of thumb: entry - 1.5x ATR).
  let atrBlockHtml = "";
  if (hasChart && ind && ind.atr) {
    const li = data.chart.close.length - 1;
    const atrVal = ind.atr[li];
    const lc = data.chart.close[li];
    if (atrVal != null && lc != null) {
      const dp = lc >= 100 ? 1 : 2;
      const stopSuggest = lc - 1.5 * atrVal;
      const atrPct = (atrVal / lc) * 100;
      atrBlockHtml = `
        <div class="panel-block">
          <h3>ความผันผวน (ATR 14)</h3>
          <div class="metric-grid">
            <div class="metric"><span class="k">ATR (14)</span><span class="v mono">${atrVal.toFixed(dp)}</span></div>
            <div class="metric"><span class="k">ATR % ของราคา</span><span class="v mono">${atrPct.toFixed(2)}%</span></div>
          </div>
          <div class="ratio-note" style="margin-top:10px;">อ้างอิงคร่าวๆ สำหรับตั้ง Stop Loss แบบ 1.5x ATR: ประมาณ <b style="color:var(--text)">${stopSuggest.toFixed(dp)}</b> — เป็นแนวทางทั่วไป ไม่ใช่คำแนะนำการลงทุน ควรพิจารณาแนวรับ/ต้านจริงร่วมด้วย</div>
        </div>`;
    }
  }

  // Multi-timeframe confirmation: does the weekly trend agree with the
  // daily signal, or is this daily setup fighting the bigger trend?
  let mtfBlockHtml = "";
  if (ind && ind.signals) {
    const dailyBull = ind.signals.emaBullish;
    const dailyBear = ind.signals.emaBearish;
    const dailyLabel = dailyBull ? "1D: ขาขึ้น" : dailyBear ? "1D: ขาลง" : "1D: ไม่ชัดเจน";
    const dailyType = dailyBull ? "sig-bull" : dailyBear ? "sig-bear" : "sig-neu";

    const wb = data.weeklyBias;
    let weeklyLabel = "1W: ไม่มีข้อมูล";
    let weeklyType = "sig-neu";
    let note = "ข้อมูลรายสัปดาห์ไม่พอสำหรับเทียบแนวโน้ม";
    if (wb) {
      weeklyLabel = wb.bias === "bullish" ? "1W: ขาขึ้น" : "1W: ขาลง";
      weeklyType = wb.bias === "bullish" ? "sig-bull" : "sig-bear";
      const dailyDir = dailyBull ? "bullish" : dailyBear ? "bearish" : null;
      if (dailyDir && dailyDir === wb.bias) {
        note = "แนวโน้มรายวันกับรายสัปดาห์สอดคล้องกัน — สัญญาณรายวันมีน้ำหนักมากขึ้น";
      } else if (dailyDir) {
        note = "⚠️ แนวโน้มรายวันกับรายสัปดาห์ไม่ตรงกัน — สัญญาณรายวันอาจเป็นสัญญาณสวนเทรนด์หลัก ควรระวังสัญญาณหลอก";
      }
    }
    mtfBlockHtml = `
      <div class="panel-block">
        <h3>Multi-Timeframe</h3>
        <div class="signal-badges">
          <span class="sig-badge ${dailyType}">${dailyLabel}</span>
          <span class="sig-badge ${weeklyType}">${weeklyLabel}</span>
        </div>
        <div class="ratio-note" style="margin-top:8px;">${note}</div>
      </div>`;
  }

  const el = document.getElementById("detailTabContent");
  el.innerHTML = `
    <div class="range-tabs" id="rangeTabs">
      ${["1mo", "3mo", "6mo", "1y"].map(r =>
        `<button data-range="${r}" class="${r === state.currentRange ? "active" : ""}">${r}</button>`
      ).join("")}
    </div>

    ${toggleButtonsHtml()}

    <div class="chart-card" id="panel-candle">
      <div class="chart-panel-label">ราคา (แท่งเทียน) + EMA / VWAP / Bollinger Bands</div>
      <canvas id="priceChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>ราคาขึ้น</span>
        <span><i class="dot" style="background:var(--danger)"></i>ราคาลง</span>
        <span><i class="dot" style="background:#ffa657"></i>EMA15</span>
        <span><i class="dot" style="background:#d2a8ff"></i>EMA50</span>
        <span><i class="dot" style="background:#e3b341"></i>EMA200</span>
        <span><i class="dot" style="background:#58a6ff"></i>VWAP(20)</span>
      </div>
    </div>

    <div class="chart-card" id="panel-volume">
      <div class="chart-panel-label">ปริมาณซื้อขาย (Buy / Sell Volume)</div>
      <canvas id="volChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>แรงซื้อ</span>
        <span><i class="dot" style="background:var(--danger)"></i>แรงขาย</span>
        <span><i class="dot" style="background:#3a4050"></i>เส้นเฉลี่ย</span>
      </div>
      <div class="ratio-note" style="padding:0 8px 6px;">⚠️ ประมาณจากตำแหน่งราคาปิดในกรอบ high-low ของแต่ละแท่ง ไม่ใช่ข้อมูล order flow จริง</div>
    </div>

    <div class="chart-card" id="panel-obv">
      <div class="chart-panel-label">OBV (On-Balance Volume)</div>
      <canvas id="obvChart"></canvas>
    </div>

    <div class="chart-card" id="panel-rsi">
      <div class="chart-panel-label">RSI (14)</div>
      <canvas id="rsiChart"></canvas>
    </div>

    <div class="chart-card" id="panel-macd">
      <div class="chart-panel-label">MACD (12, 26, 9)</div>
      <canvas id="macdChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>MACD</span>
        <span><i class="dot" style="background:#ffa657"></i>Signal</span>
      </div>
    </div>

    <div class="verdict-box" style="border-color:${verdict.color}44;background:${verdict.color}14;">
      <div class="verdict-label">คะแนนรวมสัญญาณ (${score >= 0 ? "+" : ""}${score.toFixed(1)})</div>
      <div class="verdict-value" style="color:${verdict.color}">${verdict.label}</div>
      <div class="verdict-note">สรุปจากสัญญาณด้านล่างทั้งหมด — ไม่ใช่คำแนะนำการลงทุน ใช้ประกอบการตัดสินใจเท่านั้น</div>
    </div>

    <div class="panel-block">
      <h3>สัญญาณที่ตรวจพบ</h3>
      ${signalBadgesHtml(ind ? ind.signals : null)}
    </div>

    ${mtfBlockHtml}

    <div class="panel-block">
      <h3>สัญญาณปริมาณซื้อขาย</h3>
      <div class="metric-grid">
        <div class="metric"><span class="k">ปริมาณล่าสุด</span><span class="v mono">${sig ? fmtVol(sig.lastVol) : "—"}</span></div>
        <div class="metric"><span class="k">เฉลี่ย 20 วัน</span><span class="v mono">${sig ? fmtVol(sig.avgVol) : "—"}</span></div>
        <div class="metric"><span class="k">อัตราส่วนปริมาณ</span><span class="v mono">${sig ? fmtRatio(sig.volRatio) : "—"}</span></div>
        <div class="metric"><span class="k">ทิศทางราคา</span><span class="v mono ${chgClass}">${sig ? (sig.direction === "up" ? "▲ ขึ้น" : "▼ ลง") : "—"}</span></div>
      </div>
      <div class="ratio-note" style="margin-top:10px;">${interpretVolSignal(sig)}</div>
    </div>

    ${atrBlockHtml}

    <div class="panel-block">
      <h3>อัตราส่วนมูลค่า (อ่านค่าให้อัตโนมัติ)</h3>
      ${ratioRow("P/E (TTM)", fmtPlain2(rawNum(summaryDetail.trailingPE)), interpretPE(rawNum(summaryDetail.trailingPE)))}
      ${ratioRow("P/BV", fmtPlain2(rawNum(keyStats.priceToBook)), interpretPB(rawNum(keyStats.priceToBook)))}
      ${ratioRow("Beta", fmtPlain2(rawNum(keyStats.beta)), rawNum(keyStats.beta) == null ? "ไม่มีข้อมูล" : (rawNum(keyStats.beta) > 1 ? "ผันผวนมากกว่าตลาดโดยรวม" : "ผันผวนน้อยกว่าหรือใกล้เคียงตลาดโดยรวม"))}
      <div class="metric-grid" style="margin-top:12px;">
        <div class="metric"><span class="k">52w High</span><span class="v mono">${fmtPrice(rawNum(summaryDetail.fiftyTwoWeekHigh), symbol)}</span></div>
        <div class="metric"><span class="k">52w Low</span><span class="v mono">${fmtPrice(rawNum(summaryDetail.fiftyTwoWeekLow), symbol)}</span></div>
      </div>
    </div>
  `;

  applyPanelVisibility();
  if (hasChart) {
    const { chart: slicedChart, ind: slicedInd } = sliceForDisplay(data.chart, ind, state.currentRange);
    drawChart(slicedChart, slicedInd, state.chartToggles);
  }

  document.getElementById("rangeTabs").querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      state.currentRange = btn.dataset.range;
      document.getElementById("rangeTabs").querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // No network call needed — we already hold the full 1y series + indicators.
      if (hasChart) {
        const { chart: sc, ind: si } = sliceForDisplay(data.chart, ind, state.currentRange);
        drawChart(sc, si, state.chartToggles);
      }
    };
  });

  document.getElementById("chartToggles").querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.toggle;
      state.chartToggles[key] = !state.chartToggles[key];
      saveChartToggles();
      btn.classList.toggle("active", state.chartToggles[key]);
      applyPanelVisibility();
      if (hasChart) {
        const { chart: sc, ind: si } = sliceForDisplay(data.chart, ind, state.currentRange);
        drawChart(sc, si, state.chartToggles);
      }
    };
  });
}

function renderDetailTabFinancials(symbol) {
  const data = state.currentDetailData;
  const f = data.fundamentals || {};
  const finData = f.financialData || {};
  const summaryDetail = f.summaryDetail || {};

  const el = document.getElementById("detailTabContent");
  el.innerHTML = `
    <div class="panel-block">
      <h3>อัตราส่วนความสามารถทำกำไร / ฐานะการเงิน</h3>
      ${ratioRow("ROE", finData.returnOnEquity ? fmtPercentField(rawNum(finData.returnOnEquity)) : "—", interpretROE(rawNum(finData.returnOnEquity)))}
      ${ratioRow("D/E (x100)", fmtPlain2(rawNum(finData.debtToEquity)), interpretDE(rawNum(finData.debtToEquity)))}
      ${ratioRow("Gross Margin", finData.grossMargins ? fmtPercentField(rawNum(finData.grossMargins)) : "—", rawNum(finData.grossMargins) == null ? "ไม่มีข้อมูล" : "ยิ่งสูงยิ่งแปลว่าควบคุมต้นทุนขายได้ดี เทียบกับคู่แข่งในอุตสาหกรรมเดียวกัน")}
      ${ratioRow("Revenue Growth", finData.revenueGrowth ? fmtPercentField(rawNum(finData.revenueGrowth)) : "—", rawNum(finData.revenueGrowth) == null ? "ไม่มีข้อมูล" : (rawNum(finData.revenueGrowth) > 0 ? "รายได้เติบโตเทียบปีก่อน" : "รายได้หดตัวเทียบปีก่อน"))}
      <div class="metric-grid" style="margin-top:12px;">
        <div class="metric"><span class="k">Market Cap</span><span class="v mono">${fmtBig(rawNum(summaryDetail.marketCap))}</span></div>
      </div>
    </div>
    <div class="panel-block" id="fullFinancialsBlock">
      <h3>งบการเงินฉบับเต็ม (รายได้ / กำไรสุทธิ / สินทรัพย์ ย้อนหลัง)</h3>
      <div class="empty-state" style="padding:20px 4px;">
        <div class="glyph">⏳</div>
        <p style="font-size:13px;">กำลังตรวจสอบแหล่งข้อมูล…</p>
      </div>
    </div>
  `;

  apiFetchFullFinancials(symbol).then(result => {
    const block = document.getElementById("fullFinancialsBlock");
    if (!block) return;
    if (!result) {
      block.innerHTML = `
        <h3>งบการเงินฉบับเต็ม (รายได้ / กำไรสุทธิ / สินทรัพย์ ย้อนหลัง)</h3>
        <div class="api-placeholder">
          <p>ยังไม่ได้เชื่อมต่อแหล่งข้อมูลงบการเงินฉบับเต็ม</p>
          <p class="hint2">ตัวเชื่อมต่อเตรียมไว้แล้วที่ไฟล์ <code>api-adapters.js</code> (ฟังก์ชัน <code>apiFetchFullFinancials</code>) — ใส่ API key/endpoint ของผู้ให้บริการที่ต้องการ เช่น SET SMART หรือ Finnhub แล้วข้อมูลจะแสดงที่นี่โดยไม่ต้องแก้ UI</p>
        </div>`;
    } else {
      // TODO: render real statement rows once a provider is connected
      block.innerHTML = `<h3>งบการเงินฉบับเต็ม</h3><pre class="mono" style="white-space:pre-wrap;font-size:11px;">${JSON.stringify(result, null, 2)}</pre>`;
    }
  });
}

function renderDetailTabDividend(symbol) {
  const data = state.currentDetailData;
  const f = data.fundamentals || {};
  const summaryDetail = f.summaryDetail || {};
  const divYield = rawNum(summaryDetail.dividendYield);
  const divRate = rawNum(summaryDetail.dividendRate);
  const exDivRaw = rawNum(summaryDetail.exDividendDate);
  const exDivDate = exDivRaw ? new Date(exDivRaw * 1000).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" }) : "—";

  const el = document.getElementById("detailTabContent");
  el.innerHTML = `
    <div class="panel-block">
      <h3>เงินปันผล</h3>
      ${ratioRow("Dividend Yield", divYield ? fmtPercentField(divYield) : "—", interpretDivYield(divYield))}
      <div class="metric-grid" style="margin-top:12px;">
        <div class="metric"><span class="k">ปันผลต่อหุ้น (ล่าสุด)</span><span class="v mono">${divRate != null ? fmtPrice(divRate, symbol) : "—"}</span></div>
        <div class="metric"><span class="k">วันขึ้นเครื่องหมาย XD ล่าสุด</span><span class="v mono">${exDivDate}</span></div>
      </div>
    </div>
    <div class="panel-block" id="divHistoryBlock">
      <h3>ประวัติการจ่ายปันผลย้อนหลัง</h3>
      <div class="empty-state" style="padding:20px 4px;">
        <div class="glyph">⏳</div>
        <p style="font-size:13px;">กำลังตรวจสอบแหล่งข้อมูล…</p>
      </div>
    </div>
  `;

  apiFetchDividendHistory(symbol).then(result => {
    const block = document.getElementById("divHistoryBlock");
    if (!block) return;
    if (!result) {
      block.innerHTML = `
        <h3>ประวัติการจ่ายปันผลย้อนหลัง</h3>
        <div class="api-placeholder">
          <p>ยังไม่ได้เชื่อมต่อแหล่งข้อมูลประวัติปันผลแบบละเอียด</p>
          <p class="hint2">ต่อได้ที่ <code>api-adapters.js</code> → <code>apiFetchDividendHistory</code></p>
        </div>`;
    }
  });
}

function renderDetailTabDW(symbol) {
  const el = document.getElementById("detailTabContent");
  el.innerHTML = `
    <div class="panel-block" id="dwBlock">
      <h3>DW (ใบสำคัญแสดงสิทธิอนุพันธ์) อ้างอิงหุ้นนี้</h3>
      <div class="empty-state" style="padding:20px 4px;">
        <div class="glyph">⏳</div>
        <p style="font-size:13px;">กำลังตรวจสอบแหล่งข้อมูล…</p>
      </div>
    </div>
  `;

  apiFetchDWList(symbol).then(result => {
    const block = document.getElementById("dwBlock");
    if (!block) return;
    if (!result || !result.length) {
      block.innerHTML = `
        <h3>DW (ใบสำคัญแสดงสิทธิอนุพันธ์) อ้างอิงหุ้นนี้</h3>
        <div class="api-placeholder">
          <p>ยังไม่ได้เชื่อมต่อแหล่งข้อมูล DW — ข้อมูล DW ไม่มีใน public API ฟรีทั่วไป ต้องใช้ฟีดจาก SET SMART หรือโบรกเกอร์</p>
          <p class="hint2">จุดเชื่อมต่อเตรียมไว้แล้วที่ <code>api-adapters.js</code> → <code>apiFetchDWList</code> พร้อมตัวอย่างรูปแบบข้อมูลที่ควร return ในคอมเมนต์</p>
        </div>`;
    } else {
      block.innerHTML = `<h3>DW อ้างอิงหุ้นนี้</h3>` + result.map(dw => `
        <div class="metric-grid" style="margin-bottom:10px;border-bottom:1px solid var(--border);padding-bottom:10px;">
          <div class="metric"><span class="k">${dw.dwSymbol}</span><span class="v mono">${dw.type}</span></div>
          <div class="metric"><span class="k">ราคาล่าสุด</span><span class="v mono">${dw.lastPrice}</span></div>
        </div>`).join("");
    }
  });
}

function toggleWatch(symbol) {
  const idx = state.watchlist.indexOf(symbol);
  if (idx >= 0) {
    state.watchlist.splice(idx, 1);
    toast("นำออกจากรายการติดตามแล้ว");
  } else {
    state.watchlist.push(symbol);
    toast("เพิ่มในรายการติดตามแล้ว");
  }
  saveWatchlist();
  const btn = document.getElementById("watchToggleBtn");
  if (btn) {
    const inWatch = state.watchlist.includes(symbol);
    btn.classList.toggle("on", inWatch);
    btn.textContent = inWatch ? "★ อยู่ในรายการติดตามแล้ว" : "☆ เพิ่มในรายการติดตาม";
  }
}

// ---------------- canvas setup helper ----------------
function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth - 12;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { ctx, cssWidth, cssHeight };
}

function xAt(i, n, plotW, padL) { return padL + (plotW * i) / ((n - 1) || 1); }

function drawGridLines(ctx, cssWidth, top, height, padL, padR, lines) {
  ctx.strokeStyle = "#2a2e3a";
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  lines.forEach((frac) => {
    const y = top + height * frac;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssWidth - padR, y);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function drawDashedHLine(ctx, y, x0, x1, color, dash = [4, 4]) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.restore();
}

// ---------------- panel: candlestick price + EMA + Bollinger + S/R ----------------
function drawPricePanel(chart, ind, toggles) {
  const canvas = document.getElementById("priceChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 230);

  const opens = chart.open, highs = chart.high, lows = chart.low, closes = chart.close;
  const n = closes.length;
  if (!n) return;

  const { ema15, ema50, ema200, bollinger, vwap, supportResistance } = ind;

  // Price range must cover EVERYTHING that's about to be drawn — candles,
  // Bollinger (if on), VWAP (if on), AND the support/resistance + POC lines
  // (which draw unconditionally). Previously S/R levels outside the
  // candle/BB range would be drawn at an off-canvas y — this always
  // widens the range to fit them instead.
  let candidates = [...highs, ...lows].filter(v => v != null);
  if (toggles.bb) {
    candidates = candidates.concat(
      bollinger.upper.filter(v => v != null),
      bollinger.lower.filter(v => v != null)
    );
  }
  if (toggles.vwap && vwap) {
    candidates = candidates.concat(vwap.filter(v => v != null));
  }
  if (supportResistance) {
    [supportResistance.r2, supportResistance.r1, supportResistance.s1, supportResistance.s2]
      .forEach(v => { if (v != null) candidates.push(v); });
  }
  if (ind.poc != null) candidates.push(ind.poc);
  if (!candidates.length) return;

  const maxP = Math.max(...candidates);
  const minP = Math.min(...candidates);
  const range = (maxP - minP) || 1;

  // Reserve room on the right for price-axis labels and at the bottom for
  // date ticks (previously the chart had no axis labels at all).
  const padL = 4, padR = 42, padT = 8, padB = 18;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;

  const gridFracs = [0, 0.25, 0.5, 0.75, 1];
  drawGridLines(ctx, cssWidth, padT, plotH, padL, padR, gridFracs);

  const yAt = (p) => padT + plotH - ((p - minP) / range) * plotH;

  // Bollinger Bands (drawn first, underneath candles)
  if (toggles.bb) {
    function drawDashedSeries(arr, color) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (arr[i] == null) continue;
        const x = xAt(i, n, plotW, padL);
        const y = yAt(arr[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
      ctx.restore();
    }
    drawDashedSeries(bollinger.upper, "#8b93a1");
    drawDashedSeries(bollinger.lower, "#8b93a1");
  }

  // Support / resistance levels
  if (supportResistance) {
    const { r2, r1, s1, s2 } = supportResistance;
    const x0 = padL, x1 = cssWidth - padR;
    if (r2 != null) drawDashedHLine(ctx, yAt(r2), x0, x1, "rgba(255,92,92,0.55)");
    if (r1 != null) drawDashedHLine(ctx, yAt(r1), x0, x1, "rgba(255,92,92,0.35)");
    if (s1 != null) drawDashedHLine(ctx, yAt(s1), x0, x1, "rgba(0,214,143,0.35)");
    if (s2 != null) drawDashedHLine(ctx, yAt(s2), x0, x1, "rgba(0,214,143,0.55)");
  }

  // POC (Point of Control) — hook for a future volume-profile calc; drawn
  // only if the caller supplies one (not computed in this app yet).
  if (ind.poc != null) {
    drawDashedHLine(ctx, yAt(ind.poc), padL, cssWidth - padR, "#e3b341", [2, 2]);
  }

  // Candlesticks
  if (toggles.candle) {
    const candleW = Math.max(1.5, (plotW / n) * 0.62);
    for (let i = 0; i < n; i++) {
      if (opens[i] == null || closes[i] == null || highs[i] == null || lows[i] == null) continue;
      const x = xAt(i, n, plotW, padL);
      const up = closes[i] >= opens[i];
      ctx.strokeStyle = ctx.fillStyle = up ? "#00d68f" : "#ff5c5c";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAt(highs[i]));
      ctx.lineTo(x, yAt(lows[i]));
      ctx.stroke();
      const yO = yAt(opens[i]), yC = yAt(closes[i]);
      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - candleW / 2, top, candleW, h);
    }
  }

  // EMA overlays
  if (toggles.ema) {
    function drawEmaLine(ema, color) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (ema[i] == null) continue;
        const x = xAt(i, n, plotW, padL);
        const y = yAt(ema[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    drawEmaLine(ema15, "#ffa657");
    drawEmaLine(ema50, "#d2a8ff");
    drawEmaLine(ema200, "#e3b341");
  }

  // VWAP overlay (rolling 20-bar, see calcVWAP comment for why not a
  // classic session VWAP)
  if (toggles.vwap && vwap) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (vwap[i] == null) continue;
      const x = xAt(i, n, plotW, padL);
      const y = yAt(vwap[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // ---- axis labels (price on the right, dates along the bottom) ----
  const dp = maxP >= 100 ? 1 : 2;
  ctx.save();
  ctx.font = "9px SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#5a6172";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  gridFracs.forEach((frac) => {
    const price = maxP - frac * range;
    const y = padT + plotH * frac;
    ctx.fillText(price.toFixed(dp), cssWidth - padR + 4, y);
  });
  ctx.restore();

  if (chart.timestamps && chart.timestamps.length === n) {
    ctx.save();
    ctx.font = "9px SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = "#5a6172";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tickCount = Math.min(5, n);
    for (let t = 0; t < tickCount; t++) {
      const i = tickCount === 1 ? 0 : Math.round((t / (tickCount - 1)) * (n - 1));
      const ts = chart.timestamps[i];
      if (ts == null) continue;
      const d = new Date(ts * 1000);
      const label = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
      const x = xAt(i, n, plotW, padL);
      ctx.fillText(label, Math.min(Math.max(x, padL + 12), cssWidth - padR - 12), padT + plotH + 4);
    }
    ctx.restore();
  }
}

// ---------------- panel: buy/sell volume (stacked) ----------------
function drawVolumePanel(chart) {
  const canvas = document.getElementById("volChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 100);

  const highs = chart.high, lows = chart.low, closes = chart.close, vols = chart.volume;
  const n = closes.length;
  if (!n) return;

  const buyVol = new Array(n).fill(0), sellVol = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (vols[i] == null || highs[i] == null || lows[i] == null || closes[i] == null) continue;
    const hl = highs[i] - lows[i];
    const bv = hl > 0 ? vols[i] * ((closes[i] - lows[i]) / hl) : vols[i] / 2;
    buyVol[i] = bv;
    sellVol[i] = vols[i] - bv;
  }
  const totals = vols.map(v => v || 0);
  const maxV = Math.max(...totals, 1);
  const validVols = vols.filter(v => v != null);
  const avgV = validVols.length ? validVols.reduce((a, b) => a + b, 0) / validVols.length : 0;

  // padR matches drawPricePanel so bars line up under the same candle
  const padL = 4, padR = 42, padT = 6, padB = 6;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;
  const barW = Math.max(1.5, (plotW / n) * 0.62);

  for (let i = 0; i < n; i++) {
    if (vols[i] == null) continue;
    const x = xAt(i, n, plotW, padL);
    const bH = (buyVol[i] / maxV) * plotH;
    const sH = (sellVol[i] / maxV) * plotH;
    ctx.fillStyle = "rgba(0,214,143,0.75)";
    ctx.fillRect(x - barW / 2, padT + plotH - bH, barW, bH);
    ctx.fillStyle = "rgba(255,92,92,0.7)";
    ctx.fillRect(x - barW / 2, padT + plotH - bH - sH, barW, sH);
  }

  if (avgV) {
    const y = padT + plotH - (avgV / maxV) * plotH;
    drawDashedHLine(ctx, y, padL, cssWidth - padR, "#5a6172", [3, 3]);
  }

  ctx.save();
  ctx.font = "9px SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#5a6172";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtVol(maxV), cssWidth - padR + 4, padT);
  if (avgV) ctx.fillText("avg " + fmtVol(avgV), cssWidth - padR + 4, padT + plotH - (avgV / maxV) * plotH);
  ctx.restore();
}

// ---------------- panel: OBV ----------------
function drawOBVPanel(obv) {
  const canvas = document.getElementById("obvChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 80);

  const n = obv.length;
  if (!n) return;
  const minO = Math.min(...obv), maxO = Math.max(...obv);
  const range = (maxO - minO) || 1;

  const padL = 4, padR = 42, padT = 6, padB = 6;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;
  const yAt = (v) => padT + plotH - ((v - minO) / range) * plotH;

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i, n, plotW, padL);
    const y = yAt(obv[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(xAt(n - 1, n, plotW, padL), padT + plotH);
  ctx.lineTo(padL, padT + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, "rgba(0,214,143,0.22)");
  grad.addColorStop(1, "rgba(0,214,143,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i, n, plotW, padL);
    const y = yAt(obv[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#00d68f";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.save();
  ctx.font = "9px SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#5a6172";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtVol(maxO), cssWidth - padR + 4, padT);
  ctx.fillText(fmtVol(minO), cssWidth - padR + 4, padT + plotH);
  ctx.restore();
}

// ---------------- panel: RSI ----------------
function drawRSIPanel(rsi) {
  const canvas = document.getElementById("rsiChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 90);

  const n = rsi.length;
  if (!n) return;
  const padL = 4, padR = 42, padT = 6, padB = 6;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;
  const yAt = (v) => padT + plotH - (v / 100) * plotH;

  drawDashedHLine(ctx, yAt(70), padL, cssWidth - padR, "rgba(255,92,92,0.55)");
  drawDashedHLine(ctx, yAt(50), padL, cssWidth - padR, "rgba(58,64,80,0.9)", [3, 3]);
  drawDashedHLine(ctx, yAt(30), padL, cssWidth - padR, "rgba(0,214,143,0.55)");

  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    if (rsi[i] == null) continue;
    const x = xAt(i, n, plotW, padL);
    const y = yAt(rsi[i]);
    if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
  }
  ctx.strokeStyle = "#ffa657";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.save();
  ctx.font = "9px SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#5a6172";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  [[70, "70"], [50, "50"], [30, "30"]].forEach(([level, label]) => {
    ctx.fillText(label, cssWidth - padR + 4, yAt(level));
  });
  ctx.restore();
}

// ---------------- panel: MACD ----------------
function drawMACDPanel(macd) {
  const canvas = document.getElementById("macdChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 90);

  const { macd: macdLine, signal: signalLine, histogram } = macd;
  const n = macdLine.length;
  if (!n) return;
  const vals = [...macdLine, ...signalLine, ...histogram].filter(v => v != null);
  if (!vals.length) return;
  const maxAbs = Math.max(...vals.map(v => Math.abs(v)), 1e-9);

  const padL = 4, padR = 42, padT = 6, padB = 6;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;
  const midY = padT + plotH / 2;
  const yAt = (v) => midY - (v / maxAbs) * (plotH / 2);
  const barW = Math.max(1.5, (plotW / n) * 0.6);

  ctx.strokeStyle = "#3a4050";
  ctx.beginPath();
  ctx.moveTo(padL, midY);
  ctx.lineTo(cssWidth - padR, midY);
  ctx.stroke();

  for (let i = 0; i < n; i++) {
    if (histogram[i] == null) continue;
    const x = xAt(i, n, plotW, padL);
    const y = yAt(histogram[i]);
    ctx.fillStyle = histogram[i] >= 0 ? "rgba(0,214,143,0.6)" : "rgba(255,92,92,0.6)";
    ctx.fillRect(x - barW / 2, Math.min(y, midY), barW, Math.max(1, Math.abs(y - midY)));
  }

  function drawLine(arr, color) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      const x = xAt(i, n, plotW, padL);
      const y = yAt(arr[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  drawLine(macdLine, "#00d68f");
  drawLine(signalLine, "#ffa657");

  ctx.save();
  ctx.font = "9px SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#5a6172";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("0", cssWidth - padR + 4, midY);
  ctx.restore();
}

// ---------------- master draw: render whichever panels are toggled on ----------------
// `chart` and `ind` are expected to already be sliced to the display range
// (see sliceForDisplay) and `ind` to be the pre-computed indicator bundle
// from computeIndicators(). Both come from the symbol's cached record so
// nothing here re-fetches or re-computes anything.
function drawChart(chart, ind, toggles) {
  if (!chart || !chart.close || !chart.close.length || !ind) return;

  if (toggles.candle || toggles.ema || toggles.bb || toggles.vwap) {
    drawPricePanel(chart, ind, toggles);
  }
  if (toggles.volume) drawVolumePanel(chart);
  if (toggles.obv) drawOBVPanel(ind.obv);
  if (toggles.rsi) drawRSIPanel(ind.rsi);
  if (toggles.macd) drawMACDPanel(ind.macd);
}

// ---------------- tabs / navigation ----------------
function switchTab(tab, isDetailPush) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + tab).classList.add("active");

  if (!isDetailPush) {
    state.currentTab = tab;
    document.querySelectorAll(".tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  }

  if (tab === "scanner") renderScanner();
  if (tab === "watchlist") renderWatchlist();
}

// ---------------- event wiring ----------------
function wireEvents() {
  document.querySelectorAll(".tabbar button").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("backBtn").addEventListener("click", () => switchTab(state.currentTab));

  document.getElementById("marketToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-market]");
    if (!btn) return;
    state.currentMarketFilter = btn.dataset.market;
    document.querySelectorAll("#marketToggle button").forEach(b => b.classList.toggle("active", b === btn));
    renderScanner();
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    btn.classList.add("spinning");
    if (state.currentTab === "scanner") {
      await Promise.all(state.scanList.map(it => loadSymbolData(it.symbol, { forceNetwork: true }).catch(() => {})));
      renderScanner();
    } else if (state.currentTab === "watchlist") {
      await Promise.all(state.watchlist.map(s => loadSymbolData(s, { forceNetwork: true }).catch(() => {})));
      renderWatchlist();
    }
    btn.classList.remove("spinning");
    toast("อัปเดตข้อมูลแล้ว");
  });

  document.getElementById("addTickerBtn").addEventListener("click", addTickerFromInput);
  document.getElementById("tickerInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTickerFromInput();
  });

  document.getElementById("suggestRow").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip-btn");
    if (!chip) return;
    addTicker(chip.dataset.symbol);
  });

  document.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".remove-x");
    if (removeBtn) {
      e.stopPropagation();
      const sym = removeBtn.dataset.remove;
      const list = removeBtn.dataset.list;
      removeFromList(sym, list);
      return;
    }
    const card = e.target.closest(".stock-card");
    if (card) openDetail(card.dataset.symbol);
  });

  const earlyEl = document.getElementById("earlyThreshold");
  const strongEl = document.getElementById("strongThreshold");
  earlyEl.value = state.settings.earlyTh;
  strongEl.value = state.settings.strongTh;
  document.getElementById("earlyThresholdVal").textContent = state.settings.earlyTh.toFixed(1) + "x";
  document.getElementById("strongThresholdVal").textContent = state.settings.strongTh.toFixed(1) + "x";
  document.getElementById("thStripVal").textContent = state.settings.earlyTh.toFixed(1) + "x";

  earlyEl.addEventListener("input", () => {
    let v = parseFloat(earlyEl.value);
    if (v >= state.settings.strongTh) v = state.settings.strongTh - 0.1;
    state.settings.earlyTh = v;
    document.getElementById("earlyThresholdVal").textContent = v.toFixed(1) + "x";
    document.getElementById("thStripVal").textContent = v.toFixed(1) + "x";
    saveSettings();
  });
  strongEl.addEventListener("input", () => {
    let v = parseFloat(strongEl.value);
    if (v <= state.settings.earlyTh) v = state.settings.earlyTh + 0.1;
    state.settings.strongTh = v;
    document.getElementById("strongThresholdVal").textContent = v.toFixed(1) + "x";
    saveSettings();
  });

  const proxyEl = document.getElementById("proxyUrl");
  proxyEl.value = state.settings.proxyUrl;
  proxyEl.addEventListener("change", () => {
    state.settings.proxyUrl = proxyEl.value.trim();
    saveSettings();
    toast("บันทึกการตั้งค่า proxy แล้ว");
  });

  const rangeSel = document.getElementById("defaultRange");
  rangeSel.value = state.settings.defaultRange;
  rangeSel.addEventListener("change", () => {
    state.settings.defaultRange = rangeSel.value;
    state.currentRange = rangeSel.value;
    saveSettings();
  });

  document.getElementById("clearDataBtn").addEventListener("click", () => {
    if (!confirm("ล้างข้อมูลทั้งหมดในเครื่อง (รายการสแกน, รายการติดตาม, แคช, การตั้งค่า)? การกระทำนี้ย้อนกลับไม่ได้")) return;
    Object.keys(localStorage).forEach(k => { if (k.startsWith("vs_")) localStorage.removeItem(k); });
    state.scanList = DEFAULT_SCAN_LIST.slice();
    state.watchlist = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveScanList(); saveWatchlist(); saveSettings();
    toast("ล้างข้อมูลเรียบร้อย");
    switchTab("scanner");
  });
}

function addTickerFromInput() {
  const input = document.getElementById("tickerInput");
  const raw = input.value.trim().toUpperCase();
  if (!raw) return;
  addTicker(raw);
  input.value = "";
}
function addTicker(symbol) {
  symbol = symbol.trim().toUpperCase();
  if (!symbol) return;
  if (state.scanList.some(it => it.symbol === symbol)) { toast(`${symbol} อยู่ในรายการแล้ว`); return; }
  state.scanList.push({ symbol, market: marketOf(symbol) });
  saveScanList();
  toast(`เพิ่ม ${symbol} แล้ว`);
  renderScanner();
}
function removeFromList(symbol, list) {
  if (list === "scan") {
    state.scanList = state.scanList.filter(it => it.symbol !== symbol);
    saveScanList();
    renderScanner();
  } else if (list === "watch") {
    state.watchlist = state.watchlist.filter(s => s !== symbol);
    saveWatchlist();
    renderWatchlist();
  }
}

// ---------------- offline banner ----------------
function updateOnlineBanner() {
  const el = document.getElementById("scannerOfflineNote");
  if (!el) return;
  if (!navigator.onLine) {
    el.innerHTML = `<div class="offline-note">📴 ออฟไลน์อยู่ — แสดงข้อมูลที่แคชไว้ล่าสุด</div>`;
  } else {
    el.innerHTML = "";
  }
}
window.addEventListener("online", updateOnlineBanner);
window.addEventListener("offline", updateOnlineBanner);

// ---------------- init ----------------
function init() {
  wireEvents();
  updateOnlineBanner();
  updateHeaderMeta();
  renderScanner();

  window.addEventListener("resize", () => {
    const data = state.currentDetailData;
    if (
      document.getElementById("view-detail").classList.contains("active") &&
      state.currentDetailTab === "chart" &&
      data && data.chart && data.chart.close && data.chart.close.length && data.indicators
    ) {
      const { chart: sc, ind: si } = sliceForDisplay(data.chart, data.indicators, state.currentRange);
      drawChart(sc, si, state.chartToggles);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);

// ---------------- service worker registration ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* SW registration failed, app still works online */ });
  });
}
