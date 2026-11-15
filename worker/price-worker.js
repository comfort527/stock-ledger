// 股價轉接服務（Cloudflare Worker）
//
// 用法：https://你的服務名稱.你的子網域.workers.dev/?s=00878,00937B
// 回傳：{"updated": "...", "quotes": {"00878": {"price": 21.05, ...}}, "missing": []}
//
// 雲端同步：/sync/<64 碼 id>（GET 讀、PUT 寫），資料在瀏覽器就先加密，這裡只存看不懂的密文。
//   需要在 Cloudflare 幫這個 Worker 綁一個 KV，變數名稱叫 LEDGER；/sync 可以檢查有沒有綁好。
//
// 加權指數：代號用 TWII（即時報價 ?s=TWII、日 K 線 ?k=TWII）
// 美國 VIX 恐慌指數：代號用 VIX（?s=VIX、?k=VIX，資料來自 Yahoo 的 ^VIX，美股交易時間更新）
//
// 日 K 線：?k=00878&from=2024-01-01
// 回傳：{"symbol": "00878", "source": "Yahoo", "bars": [["2024-01-02", 開, 高, 低, 收, 成交股數], ...]}
//
// 資料來源：
//   1. 證交所「基本市況報導」即時報價（上市、上櫃都有，盤中約 5 秒更新）
//   2. 抓不到時，改用證交所／櫃買中心 OpenAPI 的最近一個交易日收盤價
//   3. 日 K 線：Yahoo 奇摩股市的日線資料（.TW 上市／.TWO 上櫃），失敗時改用 FinMind 公開資料
//
// Telegram 進場訊號通知（選用）：
//   1. 在 Cloudflare 幫這個 Worker 加一個加密的 Secret，名稱 TELEGRAM_TOKEN，值是 @BotFather 給的機器人權杖
//   2. Settings → Triggers → Cron Triggers 加一條：*/5 1-5 * * 1-5（台灣時間週一到週五 9:00～13:55，每 5 分鐘）
//   3. 網頁設定頁按「測試 Telegram 通知」：會把持有中的 ETF 代號交給這裡（只有代號，沒有股數金額），並找出要傳給誰
//   盤中每 5 分鐘用和網頁一樣的條件檢查（ETF 低於 60均、RSI(6)<20、K<20、J<0，加權指數 RSI(6)<20、J<0），
//   全部成立就傳訊息；同一檔同一天只傳一次。設定存在 KV（LEDGER）的 notify:cfg。
//
// 問 AI（選用）：網頁「問 AI」分頁把帳本摘要和問題 POST 到 /chat，這裡帶上 Claude 的 API 金鑰轉給 Anthropic，回答用串流傳回網頁。
//   1. 到 console.anthropic.com 建立 API 金鑰，在 Cloudflare 幫這個 Worker 加一個加密的 Secret，名稱 ANTHROPIC_API_KEY
//   2. 用同步密碼辨認是你（第一組綁定後別的密碼不能用），每天最多 CHAT_DAILY 題；模型固定 claude-haiku-5-5
//   Cloudflare 網頁編輯器只能貼單一檔案、不能裝套件，所以這裡直接用 fetch 呼叫 Messages API，沒有用 Anthropic SDK。
//   KV（LEDGER）的 chat:cfg 只存綁定用的雜湊和當天題數，問題與回答都不存。
//   查詢工具（CHAT_TOOLS）：Claude 需要明細時會要求呼叫，工具在使用者的瀏覽器裡執行（資料只在那裡），結果再經這裡送回 Claude；
//   一題裡的工具往返不另外算題數。
//
// 這個服務只轉接公開的股價，不會碰到你的任何個人資料（問 AI 的摘要只是轉送，不保存）。

const MAX_SYMBOLS = 30;
const YAHOO_ONLY = {VIX: '%5EVIX'};   // 只有 Yahoo 有的代號（不是台股）
const UA = 'Mozilla/5.0 (stock-ledger price proxy)';
const MIS = 'https://mis.twse.com.tw/stock';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers: cors()});
    const url = new URL(request.url);
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return sync(request, url, env);
    if (url.pathname === '/notify') return notify(request, env);
    if (url.pathname === '/chat') return chat(request, env);
    if (url.searchParams.has('k')) return kline(url);
    const symbols = [...new Set((url.searchParams.get('s') || '').toUpperCase().split(',')
      .map(s => s.trim()).filter(s => /^[0-9A-Z]{4,6}$/.test(s) || YAHOO_ONLY[s]))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({error: '請用 ?s=代號,代號 指定股票，例如 ?s=00878,00937B'}, 400);

    const quotes = {}, notes = [];
    const tw = symbols.filter(s => !YAHOO_ONLY[s]);
    for (const s of symbols.filter(s => YAHOO_ONLY[s])) {
      try { const q = await quoteYahoo(s); if (q) quotes[s] = q; } catch (e) { notes.push(`${s}：` + e.message); }
    }
    if (tw.length) {
      try { Object.assign(quotes, await fromMis(tw)); }
      catch (e) { notes.push('即時報價失敗：' + e.message); }
    }

    const missing = tw.filter(s => !quotes[s]);
    if (missing.length) {
      try { Object.assign(quotes, await fromOpenApi(missing)); }
      catch (e) { notes.push('收盤價備援失敗：' + e.message); }
    }
    return json({updated: new Date().toISOString(), quotes, missing: symbols.filter(s => !quotes[s]), notes});
  },
  // 定時觸發（Cron Triggers）：盤中檢查進場訊號，成立就傳 Telegram
  async scheduled(event, env, ctx) { ctx.waitUntil(runNotify(env).catch(() => {})); },
};

// ---- 來源 1：證交所即時報價（同一個代號同時查上市 tse_ 和上櫃 otc_，只會有一邊有資料）----
async function fromMis(symbols) {
  // 加權指數（TWII）在證交所的代號是 tse_t00.tw
  const exCh = symbols.flatMap(s => s === 'TWII' ? ['tse_t00.tw'] : [`tse_${s}.tw`, `otc_${s}.tw`]).join('|');
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
    out[String(m.c).toLowerCase() === 't00' ? 'TWII' : String(m.c).toUpperCase()] = {
      name: m.n || '', price, prevClose: prev, open: num(m.o), high: num(m.h), low: num(m.l),
      volume: parseInt(m.v, 10) || 0, date: isoDate(m.d), time: m.t || '',
      market: m.ex === 'otc' ? '上櫃' : '上市', source: '即時', traded: last != null,
    };
  }
  return out;
}

// ---- Yahoo 報價（VIX 這類不是台股的代號）----
async function quoteYahoo(symbol) {
  const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_ONLY[symbol]}?range=5d&interval=1d`, {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'});
  const r = data && data.chart && data.chart.result && data.chart.result[0], m = r && r.meta;
  if (!m || !(m.regularMarketPrice > 0)) return null;
  const t = new Date((m.regularMarketTime || Date.now() / 1000) * 1000);
  return {name: symbol, price: r4(m.regularMarketPrice), prevClose: m.chartPreviousClose ? r4(m.chartPreviousClose) : null,
    high: m.regularMarketDayHigh ? r4(m.regularMarketDayHigh) : null, low: m.regularMarketDayLow ? r4(m.regularMarketDayLow) : null,
    date: new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10), time: new Date(t.getTime() + 8 * 3600000).toISOString().slice(11, 19),
    market: '美國', source: '即時', traded: true};
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
  if (!/^[0-9A-Z]{4,6}$/.test(symbol) && !YAHOO_ONLY[symbol]) return json({error: '請用 ?k=代號 指定股票，例如 ?k=00878'}, 400);
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
  for (const suffix of symbol === 'TWII' || YAHOO_ONLY[symbol] ? [''] : ['.TW', '.TWO']) {
    const ysym = symbol === 'TWII' ? '%5ETWII' : YAHOO_ONLY[symbol] || symbol + suffix;   // 加權指數在 Yahoo 是 ^TWII、VIX 是 ^VIX
    const api = `https://query1.finance.yahoo.com/v8/finance/chart/${ysym}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
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
    if (bars.length) return {source: 'Yahoo', market: symbol === 'TWII' ? '指數' : YAHOO_ONLY[symbol] ? '美國' : suffix === '.TW' ? '上市' : '上櫃', bars};
  }
  return null;
}
async function klineFinMind(symbol, from) {
  const api = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${symbol === 'TWII' ? 'TAIEX' : symbol}&start_date=${from}`;
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

// ---- Telegram 進場訊號通知 ----
const NOTIFY_KEY = 'notify:cfg', BARS_KEY = 'notify:bars';
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`,
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram HTTP ${r.status}`);
  return j.result;
}
function twNow() {   // 台灣時間
  const t = new Date(Date.now() + 8 * 3600000);
  return {day: t.toISOString().slice(0, 10), hm: t.getUTCHours() * 60 + t.getUTCMinutes(), wd: t.getUTCDay(), time: t.toISOString().slice(11, 16)};
}
// 網頁呼叫：POST /notify {key, action: 'status'|'symbols'|'test', symbols, rebind}
// key＝網頁用同步密碼算出的雜湊；第一台設定的裝置綁定後，只有同一組同步密碼的裝置能改
async function notify(request, env) {
  const kv = env && env.LEDGER;
  if (request.method === 'GET') return json({ok: true, kv: !!kv, token: !!(env && env.TELEGRAM_TOKEN)});
  if (request.method !== 'POST') return json({error: '只支援 GET、POST'}, 405);
  if (!kv) return json({error: '股價服務還沒綁定 KV（變數名稱要叫 LEDGER）'}, 501);
  if (!env.TELEGRAM_TOKEN) return json({error: 'Cloudflare 還沒設定 TELEGRAM_TOKEN（機器人權杖）'}, 501);
  let body; try { body = await request.json(); } catch (e) { return json({error: '格式不對'}, 400); }
  if (typeof body.key !== 'string' || !/^[0-9a-f]{64}$/.test(body.key)) return json({error: '缺少金鑰'}, 400);
  const owner = await sha256('notify-owner:' + body.key);
  const cfg = JSON.parse(await kv.get(NOTIFY_KEY) || '{}');
  if (cfg.owner && cfg.owner !== owner) return json({error: '通知已經被另一組同步密碼綁定了'}, 403);
  cfg.owner = owner;
  if (Array.isArray(body.symbols)) cfg.symbols = [...new Set(body.symbols.map(s => String(s).toUpperCase()).filter(s => /^[0-9A-Z]{4,6}$/.test(s)))].slice(0, MAX_SYMBOLS - 1);
  let sent = false;
  if (body.action === 'test') {
    if (cfg.lastTest && Date.now() - cfg.lastTest < 20000) return json({error: '按太快了，等 20 秒再試'}, 429);
    cfg.lastTest = Date.now();
    if (body.rebind) delete cfg.chat;
    if (!cfg.chat) {
      // 找最近一個私訊機器人的人（就是你剛剛傳「hi」的那個帳號）
      const ups = await tg(env, 'getUpdates', {limit: 100}).catch(e => ({err: e.message}));
      if (ups.err) return json({error: 'Telegram 權杖不對或連不到：' + ups.err}, 502);
      const m = ups.map(u => u.message || u.edited_message).filter(m => m && m.chat && m.chat.type === 'private').at(-1);
      if (!m) { await kv.put(NOTIFY_KEY, JSON.stringify(cfg)); return json({error: '找不到你：請先在 Telegram 打開你的機器人，傳一句話（例如 hi），再按一次測試', needHi: true}, 400); }
      cfg.chat = m.chat.id; cfg.chatName = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ').slice(0, 30);
    }
    try {
      await tg(env, 'sendMessage', {chat_id: cfg.chat, text: `✅ 股票帳本測試通知\n之後盤中每 5 分鐘檢查一次，條件成立會傳訊息給你。\n監控 ${cfg.symbols ? cfg.symbols.length : 0} 檔：${(cfg.symbols || []).join('、') || '（還沒有）'}`});
      sent = true;
    } catch (e) { return json({error: '傳送失敗：' + e.message}, 502); }
  }
  await kv.put(NOTIFY_KEY, JSON.stringify(cfg));
  return json({ok: true, sent, chat: !!cfg.chat, chatName: cfg.chatName || '', symbols: cfg.symbols || [], lastRun: cfg.lastRun || null, lastMsg: cfg.lastMsg || ''});
}
// 和網頁一樣的指標：60均、RSI(6)（Wilder 平滑）、KD(9,3,3)、J＝3K−2D；bars：[日期, 開, 高, 低, 收]
function lastIndicators(bars) {
  const c = bars.map(b => b[4]), n = c.length;
  let ag = 0, al = 0, k = 50, d = 50, sum = 0, o = null;
  for (let i = 0; i < n; i++) {
    sum += c[i]; if (i >= 60) sum -= c[i - 60];
    if (i >= 1 && i <= 6) { const x = c[i] - c[i - 1]; if (x > 0) ag += x; else al -= x; if (i === 6) { ag /= 6; al /= 6; } }
    else if (i > 6) { const x = c[i] - c[i - 1]; ag = (ag * 5 + Math.max(x, 0)) / 6; al = (al * 5 + Math.max(-x, 0)) / 6; }
    if (i >= 8) {
      let hh = -Infinity, ll = Infinity; for (let t = i - 8; t <= i; t++) { hh = Math.max(hh, bars[t][2]); ll = Math.min(ll, bars[t][3]); }
      const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
      k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    }
    o = {close: c[i], ma60: i >= 59 ? sum / 60 : null, rsi: i >= 6 ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null, k, d, j: 3 * k - 2 * d};
  }
  return o;
}
function withLive(bars, q, day) {   // 盤中把現價當作今天這根的收盤
  bars = bars.map(x => x.slice());
  if (q && q.date === day && q.price > 0 && bars.length) {
    const last = bars[bars.length - 1];
    if (last[0] === day) { last[4] = q.price; last[2] = Math.max(last[2], q.high || q.price, q.price); last[3] = Math.min(last[3], q.low || q.price, q.price); }
    else if (last[0] < day) bars.push([day, q.open || q.price, Math.max(q.high || q.price, q.price), Math.min(q.low || q.price, q.price), q.price]);
  }
  return bars;
}
async function runNotify(env) {
  const kv = env && env.LEDGER;
  if (!kv || !env.TELEGRAM_TOKEN) return;
  const cfg = JSON.parse(await kv.get(NOTIFY_KEY) || '{}');
  if (!cfg.chat || !cfg.symbols || !cfg.symbols.length) return;
  const now = twNow();
  if (now.wd === 0 || now.wd === 6 || now.hm < 9 * 60 || now.hm > 13 * 60 + 40) return;
  const all = ['TWII', ...cfg.symbols];
  const quotes = await fromMis(all).catch(() => ({}));
  const save = async msg => { cfg.lastRun = `${now.day} ${now.time}`; cfg.lastMsg = msg; await kv.put(NOTIFY_KEY, JSON.stringify(cfg)); };
  if (!quotes.TWII || quotes.TWII.date !== now.day) return save('今天沒有開盤');
  // 日 K 一天抓一次存在 KV；一次最多補 8 檔，沒抓完的下一輪（5 分鐘後）再補
  const cache = JSON.parse(await kv.get(BARS_KEY) || '{}');
  if (cache.day !== now.day) { cache.day = now.day; cache.data = {}; }
  const from = new Date(Date.now() + 8 * 3600000 - 420 * 86400000).toISOString().slice(0, 10);
  const need = all.filter(s => !cache.data[s]).slice(0, 8);
  if (need.length) {
    await Promise.all(need.map(async s => {
      let r = null;
      try { r = await klineYahoo(s, from); } catch (e) {}
      if (!r || !r.bars.length) { try { r = await klineFinMind(s, from); } catch (e) {} }
      if (r && r.bars.length) cache.data[s] = r.bars.map(b => b.slice(0, 5));
    }));
    await kv.put(BARS_KEY, JSON.stringify(cache));
  }
  if (!cache.data.TWII) return save('加權指數日 K 還沒抓到');
  const one = s => { const b = cache.data[s]; return b && b.length > 20 ? lastIndicators(withLive(b, quotes[s], now.day)) : null; };
  const m = one('TWII'), mktOk = m && m.rsi < 20 && m.j < 0;
  const sentList = cfg.sent && cfg.sent.day === now.day ? cfg.sent.list : [];
  const hits = [];
  for (const s of cfg.symbols) {
    const x = one(s);
    if (!x || !mktOk || sentList.includes(s)) continue;
    if (x.ma60 != null && x.close < x.ma60 && x.rsi < 20 && x.k < 20 && x.j < 0) hits.push({s, ...x});
  }
  if (hits.length) {
    let vix = null; try { vix = await quoteYahoo('VIX'); } catch (e) {}
    const f = v => v.toFixed(1), lv = v => v >= 30 ? '恐慌' : v >= 20 ? '緊張' : v >= 15 ? '正常' : '平靜';
    const text = hits.map(x => `🎯 ${x.s} ${(quotes[x.s] && quotes[x.s].name) || ''} 符合進場條件\n現價 ${x.close}（60均 ${x.ma60.toFixed(2)}）・RSI ${f(x.rsi)}・K ${f(x.k)}・J ${f(x.j)}`).join('\n\n')
      + `\n\n大盤 RSI ${f(m.rsi)}・K ${f(m.k)}・J ${f(m.j)}` + (vix ? `・VIX ${vix.price.toFixed(2)}（${lv(vix.price)}）` : '') + `\n${now.day} ${now.time}`;
    try {
      await tg(env, 'sendMessage', {chat_id: cfg.chat, text});
      cfg.sent = {day: now.day, list: [...sentList, ...hits.map(x => x.s)]};
    } catch (e) { return save('傳送失敗：' + e.message); }
  }
  const done = cfg.sent && cfg.sent.day === now.day ? cfg.sent.list : [];
  return save(done.length ? `今天已通知 ${done.join('、')}` : mktOk ? '大盤成立，ETF 還沒有全部成立' : '大盤條件還沒成立');
}

// ---- 問 AI：轉給 Claude（Messages API，串流） ----
const CHAT_KEY = 'chat:cfg', CHAT_MODEL = 'claude-haiku-5-5', CHAT_DAILY = 100;
const CHAT_SYSTEM = `你是「我的股票帳本」網頁裡的助理，像一位熟悉這本帳的客服人員，用繁體中文回答使用者對自己帳本的問題。

回答原則：
- 只根據下面提供的帳本摘要回答。摘要裡沒有的資料就直接說「帳本裡沒有這項資料」，不要猜、不要自己編股價或數字。
- 用白話、簡短的方式說明，先講結論再講原因；需要計算時把算式簡單列出來。金額用「元」或「萬」，百分比留一位小數。
- 可以用條列和粗體；盡量不要用表格。
- 台股習慣：紅色＝上漲／賺，綠色＝下跌／賠。
- 可以分析和比較，但不要替使用者做買賣決定，也不要保證報酬；碰到「該不該買／賣」這類問題，說明數據和要考慮的地方，最後提醒決定權在使用者。
- 摘要是對話開始那一刻的快照，盤中股價之後可能已經變動；使用者問到即時價格時要提醒這一點。
- 摘要只是重點。需要逐筆交易、配息、某一檔的細節、借款、存款紀錄或歷史股價時，用提供的查詢工具去查，不要憑摘要推測；能一次查完的就一次查，查到的資料就是使用者帳本裡的真實紀錄。
- 帳本裡的「存款」是家人寄放的活期存款，使用者同意讓你查看。`;
// 查詢工具：全部只讀，在使用者的瀏覽器裡執行
const CHAT_TOOLS = [
  {name: 'get_transactions', description: '查買賣紀錄（ETF 與個股都有）。可依代號、日期區間、買或賣、資金來源篩選；回傳逐筆紀錄（新到舊）和合計。融資交易的金額是自備款／還完融資後的實收。',
    input_schema: {type: 'object', properties: {
      symbol: {type: 'string', description: '股票代號，例如 00929、2330；不填＝全部'},
      from: {type: 'string', description: '起日 YYYY-MM-DD（含）'}, to: {type: 'string', description: '迄日 YYYY-MM-DD（含）'},
      side: {type: 'string', enum: ['all', 'buy', 'sell'], description: '買、賣或全部，預設全部'},
      fund: {type: 'string', enum: ['all', 'own', 'pledge', 'pledgeDiv'], description: '資金來源：own 自有、pledge 質押借款、pledgeDiv 質押配息再投入；預設全部'},
      limit: {type: 'integer', description: '最多回傳幾筆，預設 100、最多 400'}}, additionalProperties: false}},
  {name: 'get_dividends', description: '查配息紀錄：發放日、除息日、每股配息、實收金額、54C 股利所得、是否待入帳。可依代號與日期篩選，回傳逐筆（新到舊）與合計。',
    input_schema: {type: 'object', properties: {
      symbol: {type: 'string', description: '股票代號；不填＝全部'},
      from: {type: 'string', description: '起日 YYYY-MM-DD（含，依發放日）'}, to: {type: 'string', description: '迄日 YYYY-MM-DD（含）'},
      limit: {type: 'integer', description: '最多幾筆，預設 100、最多 400'}}, additionalProperties: false}},
  {name: 'get_symbol_detail', description: '查單一檔股票的完整狀況：持股、成本、均價、現價、市值、未實現、已實現、配息、含息報酬、每年買進與配息統計；ETF 另附每筆買進到現在的報酬率與賺損。',
    input_schema: {type: 'object', properties: {symbol: {type: 'string', description: '股票代號'}}, required: ['symbol'], additionalProperties: false}},
  {name: 'search_symbols', description: '用代號或名稱的一部分找股票（帳本裡買賣過的），回傳代號、名稱、持股與已實現損益。不知道代號時先用這個。',
    input_schema: {type: 'object', properties: {query: {type: 'string', description: '代號或名稱的一部分，例如「華通」「23」'}}, required: ['query'], additionalProperties: false}},
  {name: 'get_loans', description: '查股票質押借款：每筆的券商、擔保品、借款金額、利率、起訖日、維持率、追繳價、已付利息、還款與繳息紀錄；可選擇包含已結清的借款。',
    input_schema: {type: 'object', properties: {
      broker: {type: 'string', description: '券商名稱，例如「元大證金」「群益證券」；不填＝全部'},
      include_closed: {type: 'boolean', description: '是否包含已結清的借款，預設否'}}, additionalProperties: false}},
  {name: 'get_credit_loans', description: '查信用貸款的攤還明細：每期扣款日、本金、利息、剩餘本金（已扣與未扣的期數都有）。',
    input_schema: {type: 'object', properties: {bank: {type: 'string', description: '銀行名稱，例如「台新銀行」「合作金庫」「LINE Bank」；不填＝全部'}}, additionalProperties: false}},
  {name: 'get_savings', description: '查家人寄放的活期存款：名稱、年利率、目前結餘、累計存入／提款／利息、還沒登記的利息，以及存提紀錄（新到舊）。',
    input_schema: {type: 'object', properties: {limit: {type: 'integer', description: '紀錄最多幾筆，預設 60、最多 400'}}, additionalProperties: false}},
  {name: 'get_price_history', description: '查某一檔（或加權指數 TWII）最近的每日收盤價與 60 日均線、RSI(6)、K、J。只有網頁抓過日 K 的代號才有（持有中的 ETF 和加權指數）。',
    input_schema: {type: 'object', properties: {
      symbol: {type: 'string', description: '代號，或 TWII（加權指數）'},
      days: {type: 'integer', description: '最近幾個交易日，預設 20、最多 120'}}, required: ['symbol'], additionalProperties: false}},
].map(t => ({...t, eager_input_streaming: true}));
async function chat(request, env) {
  const kv = env && env.LEDGER;
  if (request.method === 'GET') return json({ok: true, kv: !!kv, key: !!(env && env.ANTHROPIC_API_KEY), model: CHAT_MODEL});
  if (request.method !== 'POST') return json({error: '只支援 GET、POST'}, 405);
  if (!kv) return json({error: '股價服務還沒綁定 KV（變數名稱要叫 LEDGER）'}, 501);
  if (!env.ANTHROPIC_API_KEY) return json({error: 'Cloudflare 還沒設定 ANTHROPIC_API_KEY（Claude 的 API 金鑰）'}, 501);
  let body; try { body = await request.json(); } catch (e) { return json({error: '格式不對'}, 400); }
  if (typeof body.key !== 'string' || !/^[0-9a-f]{64}$/.test(body.key)) return json({error: '缺少金鑰'}, 400);
  const summary = typeof body.summary === 'string' ? body.summary : '';
  if (!summary || summary.length > 80000) return json({error: '帳本摘要不對'}, 400);
  // 對話：使用者（文字或工具結果）與 Claude（文字、思考、工具呼叫）輪流，最後一則是使用者
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const okA = b => b && (b.type === 'text' ? typeof b.text === 'string' : b.type === 'thinking' ? typeof b.signature === 'string'
    : b.type === 'redacted_thinking' ? typeof b.data === 'string' : b.type === 'tool_use' ? typeof b.id === 'string' && typeof b.name === 'string' && b.input && typeof b.input === 'object' : false);
  const okU = b => b && (b.type === 'text' ? typeof b.text === 'string' && b.text.length <= 4000
    : b.type === 'tool_result' ? typeof b.tool_use_id === 'string' && typeof b.content === 'string' && b.content.length <= 60000 : false);
  const valid = msgs.length >= 1 && msgs.length <= 121 && msgs.length % 2 === 1 && msgs.every((m, i) => m && m.role === (i % 2 ? 'assistant' : 'user')
    && (typeof m.content === 'string' ? m.content.trim() && m.content.length <= 4000
      : Array.isArray(m.content) && m.content.length && m.content.every(i % 2 ? okA : okU)))
    && JSON.stringify(msgs).length <= 900000;
  if (!valid) return json({error: '對話內容不對，請按「新對話」重新開始'}, 400);
  const last = msgs[msgs.length - 1], isNew = typeof last.content === 'string' || last.content.every(b => b.type === 'text');   // 工具結果不算新的一題
  const owner = await sha256('chat-owner:' + body.key);
  const cfg = JSON.parse(await kv.get(CHAT_KEY) || '{}');
  if (cfg.owner && cfg.owner !== owner) return json({error: '問 AI 已經被另一組同步密碼綁定了'}, 403);
  const day = twNow().day;
  if (cfg.day !== day) { cfg.day = day; cfg.count = 0; }
  if (isNew && cfg.count >= CHAT_DAILY) return json({error: `今天已經問了 ${CHAT_DAILY} 題，明天再來`}, 429);
  if (isNew || cfg.owner !== owner) { cfg.owner = owner; cfg.count = (cfg.count || 0) + (isNew ? 1 : 0); await kv.put(CHAT_KEY, JSON.stringify(cfg)); }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2026-10-21'},
    body: JSON.stringify({
      model: CHAT_MODEL, max_tokens: 4096, stream: true,
      output_config: {effort: 'low'},   // 聊天用最省、最快的等級
      // 說明＋帳本摘要放在 system，對話中不變，讓提示快取（cache_control）在追問時省錢
      tools: CHAT_TOOLS,
      system: [{type: 'text', text: CHAT_SYSTEM}, {type: 'text', text: '以下是使用者帳本目前的摘要：\n\n' + summary}],
      cache_control: {type: 'ephemeral'},   // 自動快取到最後一個區塊：工具說明＋摘要＋前面的對話都會重複利用
      messages: msgs,
    }),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
    if (r.status === 401) msg = 'API 金鑰不對（請檢查 Cloudflare 的 ANTHROPIC_API_KEY）';
    else if (r.status === 429) msg = 'Claude 那邊暫時太忙或已達用量上限，請稍後再試';
    else if (r.status === 529) msg = 'Claude 暫時忙線，請稍後再試';
    if (isNew) { cfg.count--; await kv.put(CHAT_KEY, JSON.stringify(cfg)); }   // 沒問成就不算一題
    return json({error: 'Claude 回應錯誤：' + msg, status: r.status}, r.status >= 500 ? 502 : r.status);
  }
  return new Response(r.body, {headers: {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cors(), 'X-Chat-Left': String(CHAT_DAILY - cfg.count), 'Access-Control-Expose-Headers': 'X-Chat-Left'}});
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
  return {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': '*'};
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors()}});
}
