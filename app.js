/* ============================================================
   StockBomE — vanilla JS PWA stock volume-signal scanner
   No build step. No backend. All state in localStorage.
   ============================================================ */

const LS_KEYS = {
  scanList: "vs_scan_list",       // [{symbol, market}]
  watchlist: "vs_watchlist",      // [symbol]
  settings: "vs_settings",        // {earlyTh, strongTh, proxyUrl, defaultRange}
  cache: "vs_cache_",             // vs_cache_<symbol> -> {ts, chart, fundamentals, signal, range}
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

const RANGE_TO_INTERVAL = {
  "1mo": "1d", "3mo": "1d", "6mo": "1d", "1y": "1d",
};

// ---------------- state ----------------
let state = {
  settings: loadSettings(),
  scanList: loadJSON(LS_KEYS.scanList, DEFAULT_SCAN_LIST),
  watchlist: loadJSON(LS_KEYS.watchlist, []),
  currentTab: "scanner",
  currentMarketFilter: "ALL",
  currentSymbol: null,
  currentRange: null,
  isRefreshing: false,
};
state.currentRange = state.settings.defaultRange;

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

async function fetchChart(symbol, range) {
  const interval = RANGE_TO_INTERVAL[range] || "1d";
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

// Load (from cache first, then network) a full symbol record
async function loadSymbolData(symbol, { forceNetwork = false, range = null } = {}) {
  const r = range || state.currentRange;
  const cached = getCache(symbol);
  const fresh = cached && (Date.now() - cached.ts < 5 * 60 * 1000) && cached.range === r;
  if (fresh && !forceNetwork) return { data: cached, fromCache: true };

  try {
    const [chart, fundamentals] = await Promise.all([
      fetchChart(symbol, r),
      fetchFundamentals(symbol).catch(() => null),
    ]);
    const signal = computeSignal(chart);
    const record = { chart, fundamentals, signal, range: r };
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

function renderDetailTabChart(symbol) {
  const data = state.currentDetailData;
  const sig = data.signal;
  const chgClass = sig && sig.pctChange != null ? (sig.pctChange > 0 ? "up" : sig.pctChange < 0 ? "down" : "flat") : "flat";
  const f = data.fundamentals || {};
  const summaryDetail = f.summaryDetail || {};
  const keyStats = f.defaultKeyStatistics || {};

  const el = document.getElementById("detailTabContent");
  el.innerHTML = `
    <div class="range-tabs" id="rangeTabs">
      ${["1mo", "3mo", "6mo", "1y"].map(r =>
        `<button data-range="${r}" class="${r === state.currentRange ? "active" : ""}">${r}</button>`
      ).join("")}
    </div>

    <div class="chart-card">
      <div class="chart-panel-label">ราคา (แท่งเทียน) + EMA 15 / 50 / 200</div>
      <canvas id="priceChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>ราคาขึ้น</span>
        <span><i class="dot" style="background:var(--danger)"></i>ราคาลง</span>
        <span><i class="dot" style="background:#ffa657"></i>EMA15</span>
        <span><i class="dot" style="background:#d2a8ff"></i>EMA50</span>
        <span><i class="dot" style="background:#e3b341"></i>EMA200</span>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-panel-label">ปริมาณซื้อขาย (Buy / Sell Volume)</div>
      <canvas id="volChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>แรงซื้อ</span>
        <span><i class="dot" style="background:var(--danger)"></i>แรงขาย</span>
        <span><i class="dot" style="background:#3a4050"></i>เส้นเฉลี่ย</span>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-panel-label">OBV (On-Balance Volume)</div>
      <canvas id="obvChart"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-panel-label">RSI (14)</div>
      <canvas id="rsiChart"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-panel-label">MACD (12, 26, 9)</div>
      <canvas id="macdChart"></canvas>
      <div class="chart-legend">
        <span><i class="dot" style="background:var(--accent)"></i>MACD</span>
        <span><i class="dot" style="background:#ffa657"></i>Signal</span>
      </div>
    </div>

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

  drawChart(data.chart);
  document.getElementById("rangeTabs").querySelectorAll("button").forEach(btn => {
    btn.onclick = async () => {
      state.currentRange = btn.dataset.range;
      document.getElementById("rangeTabs").querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const canvas = document.getElementById("priceChart");
      canvas.style.opacity = "0.4";
      try {
        const res = await loadSymbolData(symbol, { forceNetwork: true, range: state.currentRange });
        state.currentDetailData = res.data;
        drawChart(res.data.chart);
      } catch (e) { toast("โหลดข้อมูลช่วงเวลานี้ไม่สำเร็จ"); }
      canvas.style.opacity = "1";
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

// ---------------- indicator math (no libs) ----------------
function calcEMA(values, period) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = prev; continue; }
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function calcRSI(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let avgGain = null, avgLoss = null;
  const gains = [], losses = [];
  for (let i = 1; i < values.length; i++) {
    const prevV = values[i - 1], v = values[i];
    if (prevV == null || v == null) { gains.push(0); losses.push(0); continue; }
    const d = v - prevV;
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  for (let i = 0; i < gains.length; i++) {
    if (avgGain == null) {
      if (i + 1 < period) continue;
      const gWin = gains.slice(i + 1 - period, i + 1);
      const lWin = losses.slice(i + 1 - period, i + 1);
      avgGain = gWin.reduce((a, b) => a + b, 0) / period;
      avgLoss = lWin.reduce((a, b) => a + b, 0) / period;
    } else {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

function calcMACD(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(values, fast);
  const emaSlow = calcEMA(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = calcEMA(macdLine, signal);
  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

function calcOBV(closes, vols) {
  const out = new Array(closes.length).fill(0);
  let obv = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] == null || closes[i - 1] == null || vols[i] == null) { out[i] = obv; continue; }
    if (closes[i] > closes[i - 1]) obv += vols[i];
    else if (closes[i] < closes[i - 1]) obv -= vols[i];
    out[i] = obv;
  }
  return out;
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
  ctx.strokeStyle = "#1c2130";
  ctx.lineWidth = 1;
  lines.forEach((frac) => {
    const y = top + height * frac;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssWidth - padR, y);
    ctx.stroke();
  });
}

// ---------------- panel: candlestick price + EMA ----------------
function drawPricePanel(chart, ema15, ema50, ema200) {
  const canvas = document.getElementById("priceChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 230);

  const opens = chart.open, highs = chart.high, lows = chart.low, closes = chart.close;
  const n = closes.length;
  if (!n) return;

  const validHigh = highs.filter(v => v != null);
  const validLow = lows.filter(v => v != null);
  if (!validHigh.length) return;
  const maxP = Math.max(...validHigh);
  const minP = Math.min(...validLow);
  const range = (maxP - minP) || 1;

  const padL = 4, padR = 4, padT = 8, padB = 8;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;

  drawGridLines(ctx, cssWidth, padT, plotH, padL, padR, [0, 0.25, 0.5, 0.75, 1]);

  const yAt = (p) => padT + plotH - ((p - minP) / range) * plotH;
  const candleW = Math.max(1.5, (plotW / n) * 0.62);

  for (let i = 0; i < n; i++) {
    if (opens[i] == null || closes[i] == null || highs[i] == null || lows[i] == null) continue;
    const x = xAt(i, n, plotW, padL);
    const up = closes[i] >= opens[i];
    ctx.strokeStyle = ctx.fillStyle = up ? "#00d68f" : "#ff5c5c";
    ctx.lineWidth = 1;
    // wick
    ctx.beginPath();
    ctx.moveTo(x, yAt(highs[i]));
    ctx.lineTo(x, yAt(lows[i]));
    ctx.stroke();
    // body
    const yO = yAt(opens[i]), yC = yAt(closes[i]);
    const top = Math.min(yO, yC);
    const h = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - candleW / 2, top, candleW, h);
  }

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

// ---------------- panel: buy/sell volume (stacked) ----------------
function drawVolumePanel(chart) {
  const canvas = document.getElementById("volChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 100);

  const opens = chart.open, highs = chart.high, lows = chart.low, closes = chart.close, vols = chart.volume;
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

  const padL = 4, padR = 4, padT = 6, padB = 6;
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
    ctx.strokeStyle = "#5a6172";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssWidth - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
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

  const padL = 4, padR = 4, padT = 6, padB = 6;
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
}

// ---------------- panel: RSI ----------------
function drawRSIPanel(rsi) {
  const canvas = document.getElementById("rsiChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 90);

  const n = rsi.length;
  if (!n) return;
  const padL = 4, padR = 4, padT = 6, padB = 6;
  const plotH = cssHeight - padT - padB;
  const plotW = cssWidth - padL - padR;
  const yAt = (v) => padT + plotH - (v / 100) * plotH;

  [[70, "#ff5c5c"], [50, "#3a4050"], [30, "#00d68f"]].forEach(([level, color]) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash(level === 50 ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(padL, yAt(level));
    ctx.lineTo(cssWidth - padR, yAt(level));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  });

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
}

// ---------------- panel: MACD ----------------
function drawMACDPanel(macdLine, signalLine, histogram) {
  const canvas = document.getElementById("macdChart");
  if (!canvas) return;
  const { ctx, cssWidth, cssHeight } = setupCanvas(canvas, 90);

  const n = macdLine.length;
  if (!n) return;
  const vals = [...macdLine, ...signalLine, ...histogram].filter(v => v != null);
  if (!vals.length) return;
  const maxAbs = Math.max(...vals.map(v => Math.abs(v)), 1e-9);

  const padL = 4, padR = 4, padT = 6, padB = 6;
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
}

// ---------------- master draw: compute indicators once, render all panels ----------------
function drawChart(chart) {
  const closes = chart.close;
  if (!closes || !closes.length) return;

  const ema15 = calcEMA(closes, 15);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const { macdLine, signalLine, histogram } = calcMACD(closes, 12, 26, 9);
  const obv = calcOBV(closes, chart.volume);

  drawPricePanel(chart, ema15, ema50, ema200);
  drawVolumePanel(chart);
  drawOBVPanel(obv);
  drawRSIPanel(rsi);
  drawMACDPanel(macdLine, signalLine, histogram);
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
    if (
      document.getElementById("view-detail").classList.contains("active") &&
      state.currentDetailTab === "chart" &&
      state.currentDetailData && state.currentDetailData.chart
    ) {
      drawChart(state.currentDetailData.chart);
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
