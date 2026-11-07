# AGENTS.md：給接手的 AI 助理（Codex 等）

這是一個**個人股票帳本**網頁，由使用者一步一步擴建。接手前請先讀完這份文件。

## 與使用者溝通

- **一律用繁體中文回答**，用語白話、避免術語；需要提術語時順便說明。
- 使用者主要用**手機**看結果：任何畫面改動都要同時顧到電腦版（約 1280px）和手機版（約 390px），不能出現左右捲動。
- **改完就直接 commit 並推上 GitHub（main）**，不用再問。推上去後 GitHub Pages 約 1～2 分鐘更新。
- 使用者給的對帳單、截圖數字常有打錯（價格少一位、日期顛倒）：**照數據登錄，但把可疑的地方列出來請他核對**，不要默默略過。分不出股票代號的，列出來問他。
- 不要把使用者姓名、銀行帳號、同步密碼寫進網頁或 repo（repo 是公開的；持股和借款金額使用者已同意公開）。

## 專案結構

```
index.html               整個網頁（單一檔案，HTML＋CSS＋JS，約 3,100 行）
worker/price-worker.js   Cloudflare Worker：即時股價、日 K 線、雲端同步（KV）
README.md                給一般人看的簡介
.nojekyll                GitHub Pages 設定
```

- 網址：https://comfort527.github.io/stock-ledger/
- 股價服務：https://stock-price.comfort527.workers.dev （使用者自己在 Cloudflare 部署）
- 外部套件從 jsDelivr CDN 載入：Tabler 1.6.1（CSS）、Tabler Icons 3.48.0、ECharts 6.1.0。**沒有建置流程**，直接改 `index.html`。

## 資料怎麼存

- 存在瀏覽器 `localStorage`，主鍵 `stockLedger.v1`：
  `{version:3, txSeedVer, fundSeedVer, stockTradesVer, divSeedVer, loanSeedVer, repaySeedVer, poolSeedVer, txs, divs, loans, repays, pools}`
- 其他鍵：`stockLedger.theme`、`.collapsed`、`.price`（最後抓到的股價）、`.priceApi`、`.kline`（K 線快取）、`.assetsHistory`（獲利淨值圖的精簡收盤價快取）、`.sync`（雲端同步設定）、`.snapshots`（同步前的備份點）。
- **雲端同步**：資料在瀏覽器用同步密碼加密（PBKDF2 → AES-GCM，先 gzip），存到 Worker 的 KV（`/sync/<id>`，id＝密碼的雜湊）。衝突時要使用者確認兩次才覆蓋；套用別份資料前會自動留備份點。

### 主要資料格式

- `txs`（買賣）：`{id, date, symbol, shares, price, fee, total, side?:'sell', tax?, fund?:'pledge'|'pledgeDiv', cr?:1}`
  - 買進 `total`＝成交金額＋手續費；賣出 `total`＝成交金額－手續費－交易稅（實收）。
  - `fund`：資金來源。`pledge`＝用股票質押借款買；`pledgeDiv`＝用質押部位領到的配息再買（「質押配息再投入」）。沒有＝自有資金。
  - `cr:1`：融資交易，`total` 是自備款／還完融資後的實收，不檢查金額差異。
- `divs`（配息）：`{id, symbol, payDate, amount, c54, perShare, exDate}`。有 `perShare`＋`exDate` 時會用除息前持股核對實收（扣 2.11% 補充保費、10 元匯費）。
- `loans`（股票質押借款）：`{id, broker:'元大證金'|'群益證券', colSymbol, colShares, amount, rate, startDate, dueDate, interest, interestDate, paidInterest?, paidInterestDate?, origAmount?, closedNote?, plan?, seedKey?}`
  - 元大：每筆借款有自己的擔保品，逐筆算維持率。群益：整戶共用擔保品（`pools['群益證券'].shares`）。
  - 追繳線 140%（`CALL_RATIO`），160% 以下標「注意」（`WARN_RATIO`）。額度在 `CREDIT_LIMITS`。
  - 已付利息＝`paidInterest`（券商結算累計，截至 `paidInterestDate`）＋之後的繳息紀錄；沒有券商數字的就加總繳息紀錄（見 `loanPaidInterest`）。
- `repays`（還款／繳息）：`{id, loanId, date, principal, interest, note}`。
- 信用貸款寫死在程式裡的 `CREDIT_LOANS`（台新、合作金庫、LINE Bank），扣款日一過就當作已扣。

### 內建資料（seed）與版本號

使用者給的歷史資料寫在 `index.html` 裡的常數，第一次打開或版本號升級時補進瀏覽器資料，**不會覆蓋使用者自己改過的紀錄**：

| 常數 | 內容 | 版本號 |
|---|---|---|
| `TX_SEEDS`／`SEED_xxxx` | 各檔 ETF 買賣 | `TX_SEED_VER`（新增一檔就 +1，只補「還沒有紀錄的那檔」） |
| `DIV_SEEDS`／`DIV_SEED_xxxx` | 各檔 ETF 配息 | `DIV_SEED_VER` |
| `STOCK_TRADES`、`STOCK_TRADES2`、`STOCK_DIVS` | 個股當沖／短線交易與配息 | `STOCK_TRADES_VER`（逐筆比對日期＋代號＋股數＋金額，已有就不重複加） |
| `FUND_SEED` | 資金來源標記（質押借款／質押配息再投入） | `FUND_SEED_VER`（只補在沒有標記的買進上） |
| `LOAN_SEED`、`REPAY_SEED`、`POOL_SEED` | 質押借款、還款、群益擔保品 | 各自的 `_VER` |

**要新增歷史資料時：加進對應常數並把版本號 +1。** 一次性的資料修正寫在 `load()` 裡（搜尋 `fixed = true`）。

## 畫面

- 頁首右上：功能表（買進紀錄、貼上匯入、設定）、雲端同步圖示、深淺色切換。
- 三個頁籤：**投資總覽**、**股票質押**、**信用貸款**。網址 hash 對應頁面：
  `#overview`、`#etf`、`#stock`、`#etf-<代號>`（單一股票詳細頁）、`#pledge`、`#credit`、`#buys`、`#paste`、`#settings`。
- **投資總覽**首頁：「ETF 存股」「個股買賣」兩張大卡片（代號 00 開頭算 ETF），下方依序是 ETF 配息日曆、個股獲利日曆（每月／全部期間，預設每月）。拖曳各圖下控制條可調整月份區間，上方年度金額與統計同步更新；點年度金額會將圖表與控制條縮到該年，點月份直條看每日日曆。兩張日曆的模式、月份、拖曳範圍互相獨立；按「全部期間」會重設完整範圍。點投資卡片進入各檔卡片列表，再點進單一股票詳細頁（統計卡、日 K 線、圖表、年度統計、紀錄、新增）。
- **獲利日曆**：`stockProfitEvents()` 只處理個股。每筆賣出損益＝賣出實收－`positionRun()` 平均成本法算出的對應成本，歸在賣出成交日；配息依發放日歸類，待入帳配息另列、不計入獲利，未實現損益不列入。虧損保留負數；月內買賣淨損益為 0 仍保留可點直條。
- **獲利淨值變化（原「總體資產變化」，使用者已確認 2026/11 新口徑）**：首頁日曆下方的週蠟燭＝**獲利淨值**＝ETF 市值－ETF 目前持股成本＋ETF 已實現損益（賣出實收－平均成本）＋ETF 已入帳配息（依發放日）＋個股累積獲利。**扣除借款後淨值**（只在摘要、提示與明細顯示數字，不畫折線）＝ETF 市值＋個股累積獲利＋ETF 已實現＋ETF 配息－當日借款餘額。「投資部位（ETF 市值＋個股獲利）」只在摘要、提示與明細中顯示，不畫蠟燭。借款餘額由 `debtEvents()` 依日期還原：股票質押在起息日（沒有就解析 `startNote` 的日期）借入 `max(origAmount, amount＋已還本金)`，還款日減少，結清／展延日（解析 `closedNote` 日期，或最後一筆還款日）歸零；信貸依 `amortize()` 攤還表，錨點前的期數從原貸額線性推到錨點餘額。借款利息不扣。個股獲利沿用 `stockProfitEvents()`（已實現買賣損益＋已入帳配息）。蠟燭用左側 Y 軸；計算明細可核對各項。蠟燭用同週每日估值的首筆／末筆／最高／最低彙整，並非盤中高低；本週未結束標「進行中」。可選近 13／26／52 週或全部、拖曳與更新股價；缺價週留空。歷史股價只需 ETF 與交易日參考 0050，用既有 Worker `?k=`，最多 3 檔並行、另存精簡快取（`.assetsHistory`）。金額先用萬分之一元精度累加再取整。
- **手機首頁收合**：小於 768px 時，ETF、個股、兩張日曆與獲利淨值圖預設收合，可各自展開；狀態記在 `.collapsed` 的 `home-etf`、`home-stock`、`home-calendar`、`home-profit-calendar`、`home-assets`。投資卡片收合時保留名稱、檔數與市值，點名稱仍可進列表；圖表展開後才繪製。電腦版一律顯示完整內容。
- **股票質押**：首頁只有借款、再投資（標記為質押的買進統計）。借款內有券商卡片（再進每筆借款、還款紀錄）與繳息紀錄卡片；繳息紀錄返回借款頁。
- 再投資「用借款買的股票」表：買入均價＝質押部位剩餘成本÷股數；含息均價＝（剩餘成本－該部位已入帳配息）÷股數，未扣借款利息。沿用現有資金／除息日前持股分攤，用四捨五入前數字計算；已無持股顯示「—」，手機版均價顯示在每檔下一行。
- **信用貸款**：首頁顯示總覽，點「信貸餘額合計」才顯示各家信貸明細與攤還表，可返回總覽。
- 年化報酬率：ETF 用 XIRR；個股以「最高同時投入資金」計算（短線交易用 XIRR 會失真）。

## 開發與測試

- 改程式時用小步驟、保留現有寫法與中文註解風格。
- 測試方式：用 Playwright 開 `index.html`（`file://`），分別用 1280 和 390 寬度檢查：沒有 `pageerror`、`document.documentElement.scrollWidth` 等於視窗寬度、關鍵文字正確。測試腳本和截圖放在暫存資料夾，**不要放進 repo**。
- 股價、K 線、同步都經過 Worker。修改 `worker/price-worker.js` 後，要請使用者把整份程式貼到 Cloudflare 的 `stock-price` → Edit code → Deploy（KV 綁定變數名稱是 `LEDGER`）。
- 改完：commit（訊息用繁體中文說明改了什麼）→ `git push origin main`。

## 已知待辦／注意事項

- 個股紀錄很多（約 4,700 筆交易），首頁載入約 2 秒；之後可考慮快取 `symSummary`／`positionRun` 的結果。
- 群益擔保品裡的 2352 佳世達、6962 奕力-KY、1795 美時沒有買進紀錄，只有配息。
- 部分個股交易金額對不上（融資成數不同、零股、對帳單打錯），已照表上金額登錄，損益以「賣金－買金」為準。
- 信用貸款資料寫死在 `CREDIT_LOANS`，利率變動時要手動改。
