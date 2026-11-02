// 股價轉接服務（Cloudflare Worker）
//
// 用法：https://你的服務名稱.你的子網域.workers.dev/?s=00878,00937B
// 回傳：{"updated": "...", "quotes": {"00878": {"price": 21.05, ...}}, "missing": []}
//
// 資料來源：
//   1. 證交所「基本市況報導」即時報價（上市、上櫃都有，盤中約 5 秒更新）
//   2. 抓不到時，改用證交所／櫃買中心 OpenAPI 的最近一個交易日收盤價
//
// 這個服務只轉接公開的股價，不會碰到你的任何個人資料。

const MAX_SYMBOLS = 20;
const UA = 'Mozilla/5.0 (stock-ledger price proxy)';
const MIS = 'https://mis.twse.com.tw/stock';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, {headers: cors()});
    const url = new URL(request.url);
    const symbols = [...new Set((url.searchParams.get('s') || '').toUpperCase().split(',')
      .map(s => s.trim()).filter(s => /^[0-9A-Z]{4,6}$/.test(s)))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({error: '請用 ?s=代號,代號 指定股票，例如 ?s=00878,00937B'}, 400);

    const quotes = {}, notes = [];
    try { Object.assign(quotes, await fromMis(symbols)); }
    catch (e) { notes.push('即時報價失敗：' + e.message); }

    const missing = symbols.filter(s => !quotes[s]);
    if (missing.length) {
      try { Object.assign(quotes, await fromOpenApi(missing)); }
      catch (e) { notes.push('收盤價備援失敗：' + e.message); }
    }
    return json({updated: new Date().toISOString(), quotes, missing: symbols.filter(s => !quotes[s]), notes});
  },
};

// ---- 來源 1：證交所即時報價（同一個代號同時查上市 tse_ 和上櫃 otc_，只會有一邊有資料）----
async function fromMis(symbols) {
  const exCh = symbols.flatMap(s => [`tse_${s}.tw`, `otc_${s}.tw`]).join('|');
  const api = `${MIS}/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  const headers = {'User-Agent': UA, 'Referer': `${MIS}/index.jsp`, 'Accept': 'application/json'};
  let data = await getJson(api, headers);
  if (!data.msgArray || !data.msgArray.length) {
    // 有時要先到首頁拿到 cookie，才查得到資料
    const home = await fetch(`${MIS}/index.jsp`, {headers: {'User-Agent': UA}});
    const cookie = (home.headers.get('set-cookie') || '').split(';')[0];
    if (cookie) data = await getJson(api, {...headers, Cookie: cookie});
  }
  const out = {};
  for (const m of data.msgArray || []) {
    const prev = num(m.y);
    // z：最近成交價。盤中偶爾是 "-"，就改用最佳買價、最佳賣價，再不行用昨收
    const last = num(m.z);
    const price = last ?? first(m.b) ?? first(m.a) ?? prev;
    if (!m.c || !price) continue;
    out[String(m.c).toUpperCase()] = {
      name: m.n || '', price, prevClose: prev, open: num(m.o), high: num(m.h), low: num(m.l),
      volume: parseInt(m.v, 10) || 0, date: isoDate(m.d), time: m.t || '',
      market: m.ex === 'otc' ? '上櫃' : '上市', source: '即時', traded: last != null,
    };
  }
  return out;
}

// ---- 來源 2：OpenAPI 最近收盤價（備援）----
async function fromOpenApi(symbols) {
  const out = {};
  const lists = await Promise.allSettled([
    getJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {'User-Agent': UA}),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {'User-Agent': UA}),
  ]);
  lists.forEach((res, i) => {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) return;
    for (const row of res.value) {
      const code = String(row.Code ?? row.SecuritiesCompanyCode ?? '').trim().toUpperCase();
      if (!symbols.includes(code) || out[code]) continue;
      const close = num(row.ClosingPrice ?? row.Close);
      if (!close) continue;
      out[code] = {name: row.Name ?? row.CompanyName ?? '', price: close, prevClose: null,
        date: isoDate(row.Date), time: '', market: i ? '上櫃' : '上市', source: '收盤', traded: true};
    }
  });
  return out;
}

// ---- 小工具 ----
async function getJson(url, headers) {
  const r = await fetch(url, {headers});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; }
function first(v) { return num(String(v ?? '').split('_')[0]); }
function isoDate(d) {
  const s = String(d ?? '').replace(/\D/g, '');
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;                        // 20261102
  if (s.length === 7) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}`;              // 1151102（民國）
  return '';
}
function cors() {
  return {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*'};
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors()}});
}
