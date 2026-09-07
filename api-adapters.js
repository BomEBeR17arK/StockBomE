/* ============================================================
   StockBomE — API adapter layer
   ------------------------------------------------------------
   ทุกฟังก์ชันดึงข้อมูลของแอปเรียกผ่านที่นี่ที่เดียว เพื่อให้สลับ/เพิ่ม
   แหล่งข้อมูลในอนาคตได้ง่าย โดยไม่ต้องแก้โค้ดหน้า UI (app.js)

   ตอนนี้ "quote/chart" ใช้ Yahoo Finance (ผ่าน CORS proxy) เป็นค่าเริ่มต้น
   ส่วน "งบการเงินฉบับเต็ม" และ "DW" ยังไม่ได้ต่อ API จริง — เป็นจุดเสียบ
   (stub) ที่ออกแบบไว้ล่วงหน้า ใส่ API key/endpoint ที่ CONFIG ด้านล่าง
   แล้วเติม logic ในฟังก์ชันที่มีคอมเมนต์ "TODO" ได้เลย

   แหล่งข้อมูลที่พอจะต่อได้ในอนาคต (ตัวอย่าง):
   - งบการเงินฉบับเต็ม / อัตราส่วนเพิ่มเติม: SET SMART, Finnomena API,
     Finnhub, Alpha Vantage, หรือ broker API ที่มีสิทธิ์ใช้งาน
   - DW (ใบสำคัญแสดงสิทธิอนุพันธ์): ยังไม่มี public API ฟรีที่ครอบคลุม
     ต้องใช้ฟีดจากโบรกเกอร์ หรือ SET SMART DW API (ต้องขอสิทธิ์การใช้งาน)
   ============================================================ */

const API_CONFIG = {
  // Yahoo Finance ผ่าน CORS proxy — ใช้อยู่แล้วสำหรับราคา/กราฟ/ratio พื้นฐาน
  quote: {
    provider: "yahoo-finance-unofficial",
    // proxyUrl ตั้งค่าได้ที่หน้า "ตั้งค่า" ในแอป (บันทึกใน localStorage vs_settings)
  },

  // งบการเงินฉบับเต็ม (Income Statement / Balance Sheet / Cash Flow ย้อนหลัง)
  financials: {
    provider: null,        // ใส่ชื่อ provider เช่น "set-smart" / "finnhub"
    baseUrl: "",           // เช่น "https://api.finnhub.io/api/v3"
    apiKey: "",            // ใส่ API key ของคุณ (อย่า commit key จริงขึ้น public repo!)
  },

  // เงินปันผล (จ่ายจริงย้อนหลัง / ปฏิทินขึ้นเครื่องหมาย) — เกิน field พื้นฐาน
  // ที่ Yahoo ให้มา ถ้าต้องการประวัติปันผลละเอียดกว่านี้
  dividendHistory: {
    provider: null,
    baseUrl: "",
    apiKey: "",
  },

  // DW (Derivative Warrant) — ต้องใช้ฟีดเฉพาะทาง ยังไม่มีในเวอร์ชันนี้
  dw: {
    provider: null,        // เช่น "set-smart-dw" หรือ endpoint ของโบรกเกอร์
    baseUrl: "",
    apiKey: "",
  },
};

/**
 * ดึงงบการเงินฉบับเต็ม (รายได้, กำไรสุทธิ, สินทรัพย์, หนี้สิน ย้อนหลังหลายปี)
 * @returns {Promise<object|null>} คืน null ถ้ายังไม่ได้ตั้งค่า provider
 */
async function apiFetchFullFinancials(symbol) {
  if (!API_CONFIG.financials.provider) return null;
  // TODO: ใส่ fetch จริงตรงนี้ เช่น
  // const res = await fetch(`${API_CONFIG.financials.baseUrl}/stock/financials?symbol=${symbol}&token=${API_CONFIG.financials.apiKey}`);
  // return await res.json();
  return null;
}

/**
 * ดึงประวัติเงินปันผลแบบละเอียด (ถ้าต้องการมากกว่า dividendYield/rate จาก Yahoo)
 */
async function apiFetchDividendHistory(symbol) {
  if (!API_CONFIG.dividendHistory.provider) return null;
  // TODO: ใส่ fetch จริงตรงนี้
  return null;
}

/**
 * ดึงรายชื่อ/ราคา DW ที่อ้างอิงหุ้นตัวนี้
 * @returns {Promise<Array|null>} คืน null ถ้ายังไม่ได้ตั้งค่า provider
 */
async function apiFetchDWList(symbol) {
  if (!API_CONFIG.dw.provider) return null;
  // TODO: ใส่ fetch จริงตรงนี้ เช่นเรียก endpoint ของโบรกเกอร์ที่มี DW chain
  // ตัวอย่างรูปแบบข้อมูลที่ควร return:
  // [{ dwSymbol: "PTT01C2501A", type: "Call", exercisePrice: 40, expiryDate: "2025-01-15",
  //    lastPrice: 0.15, changePct: 5.2, sensitivity: 0.85, issuer: "XX" }, ...]
  return null;
}

// เผื่อไฟล์นี้ถูกโหลดก่อน/หลัง app.js ในบางลำดับ ก็ยังใช้งานได้ผ่าน window
window.API_CONFIG = API_CONFIG;
window.apiFetchFullFinancials = apiFetchFullFinancials;
window.apiFetchDividendHistory = apiFetchDividendHistory;
window.apiFetchDWList = apiFetchDWList;
