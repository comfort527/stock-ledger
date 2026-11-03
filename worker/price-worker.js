// 股價轉接服務（Cloudflare Worker）
//
// 用法：https://你的服務名稱.你的子網域.workers.dev/?s=00878,00937B
// 回傳：{"updated": "...", "quotes": {"00878": {"price": 21.05, ...}}, "missing": []}
//
// 雲端同步：/sync/<64 碼 id>（GET 讀、PUT 寫），資料在瀏覽器就先加密，這裡只存看不懂的密文。
//   需要在 Cloudflare 幫這個 Worker 綁一個 KV，變數名稱叫 LEDGER；/sync 可以檢查有沒有綁好。
//
// 日 K 線：?k=00878&from=2024-01-01
// 回傳：{"symbol": "00878", "source": "Yahoo", "bars": [["2024-01-02", 開, 高, 低, 收, 成交股數], ...]}
//
// 資料來源：
//   1. 證交所「基本市況報導」即時報價（上市、上櫃都有，盤中約 5 秒更新）
//   2. 抓不到時，改用證交所／櫃買中心 OpenAPI 的最近一個交易日收盤價
//   3. 日 K 線：Yahoo 奇摩股市的日線資料（.TW 上市／.TWO 上櫃），失敗時改用 FinMind 公開資料
//
// 這個服務只轉接公開的股價，不會碰到你的任何個人資料。

const MAX_SYMBOLS = 20;
const UA = 'Mozilla/5.0 (stock-ledger price proxy)';
const MIS = 'https://mis.twse.com.tw/stock';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers: cors()});
    const url = new URL(request.url);
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return sync(request, url, env);
    if (url.searchParams.has('k')) return kline(url);
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

// ---- 來源 3：日 K 線（結果在 Cloudflare 快取 20 分鐘，避免一直重抓）----
async function kline(url) {
  const symbol = (url.searchParams.get('k') || '').trim().toUpperCase();
  if (!/^[0-9A-Z]{4,6}$/.test(symbol)) return json({error: '請用 ?k=代號 指定股票，例如 ?k=00878'}, 400);
  let from = url.searchParams.get('from') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { const d = new Date(Date.now() - 400 * 86400000); from = d.toISOString().slice(0, 10); }
  from = from.slice(0, 7) + '-01';   // 對齊到月初，快取比較容易命中
  const cacheKey = new Request(`https://kline.cache/${symbol}/${from}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const notes = [];
  let result = null;
  try { result = await klineYahoo(symbol, from); } catch (e) { notes.push('Yahoo：' + e.message); }
  if (!result || !result.bars.length) {
    try { result = await klineFinMind(symbol, from); } catch (e) { notes.push('FinMind：' + e.message); }
  }
  if (!result || !result.bars.length) return json({symbol, error: '查不到日 K 資料', notes}, 502);
  const res = new Response(JSON.stringify({symbol, from, updated: new Date().toISOString(), ...result, notes}),
    {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1200'}});
  await cache.put(cacheKey, res.clone());
  return withCors(res);
}
async function klineYahoo(symbol, from) {
  const p1 = Math.floor(new Date(from + 'T00:00:00+08:00').getTime() / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  for (const suffix of ['.TW', '.TWO']) {
    const api = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
    let data;
    try { data = await getJson(api, {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}); } catch (e) { continue; }
    const r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r || !r.timestamp) continue;
    const q = r.indicators.quote[0], bars = [];
    r.timestamp.forEach((ts, i) => {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if ([o, h, l, c].some(v => v == null || !(v > 0))) return;
      const date = new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);   // 換成台灣日期
      const row = [date, r4(o), r4(h), r4(l), r4(c), q.volume[i] || 0];
      if (bars.length && bars[bars.length - 1][0] === date) bars[bars.length - 1] = row; else bars.push(row);
    });
    if (bars.length) return {source: 'Yahoo', market: suffix === '.TW' ? '上市' : '上櫃', bars};
  }
  return null;
}
async function klineFinMind(symbol, from) {
  const api = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${symbol}&start_date=${from}`;
  const data = await getJson(api, {'User-Agent': UA});
  const bars = (data.data || []).filter(d => d.close > 0)
    .map(d => [d.date, d.open, d.max, d.min, d.close, d.Trading_Volume || 0]);
  return {source: 'FinMind', bars};
}
function r4(v) { return Math.round(v * 10000) / 10000; }
function withCors(res) { const r = new Response(res.body, res); for (const [k, v] of Object.entries(cors())) r.headers.set(k, v); return r; }

// ---- 雲端同步（KV）----
const MAX_SYNC_BYTES = 10 * 1024 * 1024;
async function sync(request, url, env) {
  const kv = env && env.LEDGER;
  if (url.pathname === '/sync') return json({ok: true, kv: !!kv});
  if (!kv) return json({error: '股價服務還沒綁定 KV（變數名稱要叫 LEDGER）'}, 501);
  const id = url.pathname.slice(6);
  if (!/^[0-9a-f]{64}$/.test(id)) return json({error: 'id 格式不對'}, 400);
  const key = 'ledger:' + id;
  if (request.method === 'GET') {
    const cur = await kv.get(key);
    return cur ? new Response(cur, {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors()}}) : json({error: 'not found'}, 404);
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_SYNC_BYTES) return json({error: '資料太大'}, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({error: '格式不對'}, 400); }
    if (typeof body.ct !== 'string' || typeof body.iv !== 'string') return json({error: '缺少加密資料'}, 400);
    const curText = await kv.get(key), cur = curText ? JSON.parse(curText) : null;
    // 別台裝置已經先更新過：回 409，讓網頁先拿新的再決定
    if (cur && !body.force && body.base !== cur.updatedAt) return json({error: 'conflict', updatedAt: cur.updatedAt}, 409);
    const rec = {v: 1, updatedAt: Date.now(), device: String(body.device || '').slice(0, 40), z: body.z ? 1 : 0, iv: body.iv, ct: body.ct};
    await kv.put(key, JSON.stringify(rec));
    return json({updatedAt: rec.updatedAt});
  }
  return json({error: '只支援 GET、PUT'}, 405);
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
  return {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': '*'};
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors()}});
}
