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
index.html               整個網頁（單一檔案，HTML＋CSS＋JS；內建資料一行一筆，約 6,900 行、420 KB）
worker/price-worker.js   Cloudflare Worker：即時股價、日 K 線、雲端同步（KV）、Telegram 進場訊號通知（定時觸發）、問 AI（/chat 轉給 Claude）
README.md                給一般人看的簡介
.nojekyll                GitHub Pages 設定
icon.svg、favicon-32.png                  瀏覽器分頁圖示（去背、簡化版：三疊金幣＋紅橘上升箭頭）
apple-touch-icon.png（180）、-167、-152   iPhone／iPad 主畫面圖示（滿版、不透明，圓角由系統切）
icon-192.png、icon-512.png                Android 主畫面圖示（滿版）
icon-maskable-192.png、-512.png           Android 圓形／自適應圖示（主體縮在中間 80% 安全圓內，實測最遠到 71%）
manifest.webmanifest                      Android 用的圖示清單（display 用 browser：不改變開啟方式，也避免 iOS 主畫面版另開一份 localStorage）
```

- 網址：https://comfort527.github.io/stock-ledger/
- 股價服務：https://stock-price.comfort527.workers.dev （使用者自己在 Cloudflare 部署）
- **圖示**（2026/11 重新設計，使用者選「深藍底＋金幣階梯＋發光上升箭頭」）：所有圖示網址都帶 `?v=20261115b`（`index.html` 的 `<link>` 與 `manifest.webmanifest` 裡的 `src`），換圖時兩邊的版本號要一起改，瀏覽器才會抓新圖；`theme-color` 是 `#1e2c80`。圖檔由 SVG 用 Playwright 輸出（原始 SVG 沒放進 repo）。
- 外部套件從 jsDelivr CDN 載入：Tabler 1.6.1（CSS）、Tabler Icons 3.48.0、ECharts 6.1.0。**沒有建置流程**，直接改 `index.html`。

## 資料怎麼存

- 存在瀏覽器 `localStorage`，主鍵 `stockLedger.v1`：
  `{version:3, txSeedVer, fundSeedVer, stockTradesVer, divSeedVer, loanSeedVer, repaySeedVer, poolSeedVer, txs, divs, loans, repays, pools, savings, creditPaid}`
- 其他鍵：`stockLedger.sideMini`（電腦版左側功能欄收合，預設收合）、`stockLedger.privacy`（隱私模式 1／0）、`stockLedger.stockSort`（個股列表排序）、`stockLedger.notify`（Telegram 通知已開啟、上次交給 Worker 的代號清單）、`stockLedger.theme`、`.collapsed`、`.price`（最後抓到的股價）、`.priceApi`、`.kline`（K 線快取）、`.assetsHistory`（獲利淨值圖的精簡收盤價快取）、`.sync`（雲端同步設定）、`.snapshots`（同步前的備份點）。
- **雲端同步**：資料在瀏覽器用同步密碼加密（PBKDF2 → AES-GCM，先 gzip），存到 Worker 的 KV（`/sync/<id>`，id＝密碼的雜湊）。衝突時要使用者確認兩次才覆蓋；套用別份資料前會自動留備份點。`save()` 會原樣保留這版不認得的欄位（`dataExtra`），避免舊版網頁把新功能的資料洗掉；`applyCloudText()` 遇到雲端完全沒有 `savings` 欄位、這台卻有存款時，保留這台的存款並傳回雲端；存款頁空白時可從備份點只取回存款（`savSnaps()`）。設定頁同步區顯示這台與雲端的筆數（`#syncInfo`），有「從雲端重新載入」（`#syncPull`，先留備份點再套用雲端）；「顯示同步密碼」（`#syncShowPass`，顯示這台存的密碼與字數、空白、大小寫提示，30 秒自動藏起來）；開同步時雲端找不到這組密碼會先提醒可能打錯；兩邊都有修改的衝突時，這台沒有存款而雲端有，會先收進雲端的存款。同步正在跑時又有要求（存檔、按「立即同步」、切回分頁）會記在 `syncSt.again`，這一輪結束馬上再跑；一輪結束仍有沒傳的修改（`syncDirty()`）且沒出錯就 0.8 秒後再傳；分頁切走或關掉（`visibilitychange` 變 hidden）時有沒傳的修改也會立刻同步。（2026/11 修：以前同步中又存檔會被略過，上傳慢時那筆修改要等 5 分鐘或下次打開才傳，別台按同步拿不到。）Cloudflare KV 跨地點讀取可能有約 1 分鐘延遲。頁首雲朵 `#syncBadge.sync-pending` 黃點＝這台有修改還沒上傳；使用者自己存檔（`syncUserReady` 之後、非套用雲端時，`syncSt.userSaved`）上傳成功跳「已上傳雲端 ✓」（`syncToast()`，畫面已有成功提示就接在後面、不蓋紅色錯誤），背景上傳失敗跳黃色提示並 1 分鐘後重試（`syncSt.retry`，衝突待選時不重試）。

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
- `repays`（還款／繳息）：`{id, loanId, date, principal, interest, note, due?:1}`。**日期到了才算已付**（2026/11 使用者要求；`repayDone(r)`＝`r.date <= today()`，已付利息、近 12 個月、每年、已還本金等加總都只算它，畫面與問 AI 文字把未來的標「預定」）。存檔時日期在未來的掛 `due:1`，借款餘額與「目前利息」先不扣；日期到了由 `applyDueRepays()` 補扣並拿掉 `due`（在 `load()`、匯入備份後、網頁開著每分鐘檢查）；刪除有 `due` 的紀錄不加回本金；`debtEvents()` 排除 `due` 的本金。舊版存的未來紀錄（已扣、沒有 `due`）只在借款 `interestDate` 等於那筆日期時由 `load()` 還原成預定，其餘不動。
- `savings`（家人寄放的活期存款）：`{name, rate, recs:[{id, date, kind:'in'|'out'|'int', amt, note}]}`。**名字與紀錄不可寫進 repo（涉及未成年家人）**，只存在 localStorage／加密同步／匯出備份；使用者在頁面貼上表格匯入（`savParse()`，用結餘判斷存或提）。
- 信用貸款寫死在程式裡的 `CREDIT_LOANS`（台新、合作金庫、LINE Bank），扣款日一過就當作已扣。
- `creditPaid`（信貸手動登記的已繳日期，2026/11 使用者要求）：`{信貸 id: {期數: 'YYYY-MM-DD'}}`，`creditPaidOn(c, k)` 讀取；攤還明細「還款日」右邊一欄 `已繳日期`（`input[type=date][data-cpaid]`，扣款日還沒到或已登記的期數才有，清空＝取消），登記的那一期標「已繳」、不再提醒扣款；匯出／匯入備份、雲端同步都帶著它，問 AI 的攤還表寫「已繳（手動登記 日期）」。只影響提醒與標示，不改攤還計算。

### 內建資料（seed）與版本號

使用者給的歷史資料寫在 `index.html` 裡的常數，第一次打開或版本號升級時補進瀏覽器資料，**不會覆蓋使用者自己改過的紀錄**：

| 常數 | 內容 | 版本號 |
|---|---|---|
| `TX_SEEDS`／`SEED_xxxx` | 各檔 ETF 買賣 | `TX_SEED_VER`（新增一檔就 +1，只補「還沒有紀錄的那檔」） |
| `DIV_SEEDS`／`DIV_SEED_xxxx` | 各檔 ETF 配息 | `DIV_SEED_VER` |
| `STOCK_TRADES`、`STOCK_TRADES2`、`STOCK_DIVS` | 個股當沖／短線交易與配息 | `STOCK_TRADES_VER`（逐筆比對日期＋代號＋股數＋金額，已有就不重複加） |
| `FUND_SEED` | 資金來源標記（質押借款／質押配息再投入） | `FUND_SEED_VER`（只補在沒有標記的買進上；新裝置第一次打開、按「還原」也會由 `addFundSeed()` 補上） |
| `LOAN_SEED`、`REPAY_SEED`、`POOL_SEED` | 質押借款、還款、群益擔保品 | 各自的 `_VER` |

**內建資料的寫法（2026/11 為縮小檔案改成文字格式）**：ETF 買賣、配息、個股交易、個股配息、資金來源標記都寫成「一行一筆、空白分隔」的樣板字串，載入時由 `txRows`／`divRows`／`stockRows`／`sdivRows`／`fundRows` 轉回原本的陣列（欄位順序、型別都和以前一樣，其他程式不用改）。規則：日期寫 `YYMMDD`；沒有的欄位寫 `-`，結尾的可省略；ETF 賣出在行尾加 `S 交易稅`；個股交易的賣日寫 `=` 表示同一天賣出，股數 1000 可省略（其他股數寫在行尾），融資在行尾加 `C`。例：
```
260427 43000 10.28 377 441221 S 442      ← ETF：日期 股數 單價 手續費 總金額 [S 交易稅]
240801 1990 1960                          ← 配息：配息日期 實收 54C [每股 除息日]
230104 1513 72.6 72662 = 73.9 73727       ← 個股：買日 代號 買價 買金 賣日 賣價 賣金 [股數] [C]
```
借款（`LOAN_SEED`）、還款、擔保品、信貸仍是一般物件寫法。

**要新增歷史資料時：照上面的格式加一行到對應常數並把版本號 +1。** 一次性的資料修正寫在 `load()` 裡（搜尋 `fixed = true`）。

## 畫面

- **頁首液態玻璃懸浮**（2026/11 使用者要求，和底部導覽列同款，所有寬度）：`header.navbar` 改 `position:sticky` 黏在上方（top 8px，≤440px 6px），離邊留空、圓角 22px、半透明漸層＋`backdrop-filter`、`::before` 上緣高光，深色模式另一組顏色。注意：頁首有 backdrop-filter 後，裡面 `position:fixed` 的元素會以頁首為基準，所以手機（≤575px）提醒視窗改成 `left:0;right:0;top:calc(100% + 8px)`（貼在頁首正下方）。
- 頁首右上：功能表（買進紀錄、貼上匯入、設定）、**提醒鈴鐺**、雲端同步圖示、**隱私模式**眼睛鈕（`#privBtn`）、深淺色切換。手機（≤440px）頁首按鈕間距縮小以免撐出左右捲動。
- **隱私模式**（`privacy`，存 `stockLedger.privacy`）：`MutationObserver` 把畫面文字裡「有千分位逗號或帶『萬』的數字」換成＊＊＊＊（`PRIV_RE`、`privText()`；百分比、日期、代號、股價、沒有逗號的小數字不動），原文記在 `privOrig`，關掉時還原再重畫；畫在圖表上的金額由 `wan()`／`wan1()` 回傳＊＊＊＊、`wanAxis()` 回傳空白處理（其他用 `fmt()` 畫在圖表上的數字不會遮）。
- **電腦版左側導覽列**（`#sideNav`，≥992px 才出現；這時上方 `.view-nav`、頁首「功能表」`#menuWrap` 與頁首品牌字都隱藏，body 左邊留 232px，`.container-xl` 改全寬）：投資總覽（底下 ETF 存股、個股買賣直接換網址 `#etf`／`#stock`）、股票質押、信用貸款、存款（`#sideSavTab` 跟著 `renderSavTab()`）、訊號監控；「功能」區買進紀錄／貼上匯入／設定（點了等於點 `#menuPop` 同一項）；最下面固定「新增買賣」「新增配息」（`data-side-goto`，不在投資總覽時先回去再按投資總覽上的 `data-goto` 鈕）。`showView()` 同步亮起目前頁。**可收合**：左上 `#sideToggle` 切換，收合時只留圖示（寬 64px，body 左邊留 64px，文字包在 `.lbl` 裡藏起來，游標停留顯示 title），**預設收合**，選擇記在 `stockLedger.sideMini`（'0'＝展開）；切換後重設圖表大小。768～991px（平板）維持原本上方頁籤。
- **電腦版首頁儀表板**（≥992px，`showView()` 在投資總覽首頁時給 `#homeWrap` 加 `.dash`）：CSS grid 兩欄，左欄今日漲跌摘要＋獲利淨值圖，右欄 ETF 存股、個股買賣兩張卡片，提醒橫幅橫跨兩欄；不搬動 DOM，手機版順序不變。
- **手機版美化（<768px，2026/11 使用者選定，CSS 區塊「手機版美化」）**：① 首頁今日卡 `#todayCard` 加 `.day-up`／`.day-down`（賺＝紅橘漸層、賠＝綠漸層、白字），卡片最下面多一行「持股市值」（`.today-mv`，電腦版也有）；② 功能鍵容器 `#ovActs`：首頁加 `.acts-tiles`（三格圖示方塊）、列表與詳細頁加 `.acts-chips`（一排圓角小按鈕，可左右滑），由 `applyEtfMode()` 切換；③ 首頁 ETF 存股／個股買賣卡片：`.sec-ic` 圖示方塊、標題下 `.sec-n`（幾檔持有）、收合時顯示三個小方格 `.sec-tiles`（ETF：市值／未實現／累計配息；個股：已實現／累計配息／持有），展開鈕改成只有箭頭的小圓鈕；④ 單一股票詳細頁 `#stats` 五張統計卡用 CSS grid 排成一張摘要卡（目前股價 `order:-1` 放最上面放大，其餘 2×2 小方格、不顯示圖示；DOM 與切換功能不變）；⑤ 底部導覽列半透明毛玻璃、目前頁的圖示有膠囊底色。**各檔卡片（所有寬度）**：`.sym-chip` 左邊 4px 色帶（`--bar`：含息損益賺＝紅、賠＝綠、還沒有股價＝灰）、無邊框加陰影、漲跌幅是有底色的小標籤、四列數字放進淺灰區塊。
- **手機橫向也用手機外觀**（2026/11 使用者要求）：「手機」的條件＝寬 <768，或 `(max-width:991.98px) and (orientation:landscape) and (max-height:500px)`（手機橫放；平板不算）。底部導覽列、手機版美化、首頁收合這三個 CSS 區塊的 media query 都加了這個條件；另有「手機橫向」專用區塊：把 Tabler `d-md-none` 藏掉的 `.sec-tiles`／`.sec-n`／`.home-fold-toggle` 叫回來、底部導覽列改成圖示＋文字橫排的扁列（約 38px）、首頁功能方塊橫排、`#stats` 四個小方格排一排、圖表高度縮小。JS 用 `isPhone()`（`PHONE_Q`，和 CSS 同條件）取代原本的 `innerWidth < 768`。紀錄表等用 `d-none d-md-block` 的地方在橫向仍顯示表格版（比較寬，刻意保留）。
- **動畫**（CSS 區塊「動畫」，全部包在 `prefers-reduced-motion:no-preference` 裡，系統開「減少動態效果」就不播；手機直向、橫向與電腦都有）：換頁時 `showView()` 最後呼叫 `animateIn()`，把畫面上看得到的卡片（`.today-card`、首頁功能方塊、最外層 `.card`、`.sym-chip`、提醒橫幅，最多 28 個）加 `.anim-in` 依序由下往上淡入，播完移除（每分鐘股價更新重畫不會再播）；首頁今日漲跌數字 `countUp()` 從 0 跳到目前值（隱私模式不跳）；卡片與按鈕按下縮小回彈；底部導覽列切到的圖示彈一下（`popIn`）；`#bnavMore` 由下往上、`.menu-pop` 由上往下、toast 彈出；有提醒時鈴鐺搖兩下（`#remindBtn.has-remind`，`renderRemind()` 設）；手機今日漲跌漸層卡有一道光每 6 秒掃過（`shine`）；電腦左側功能欄展開收合有滑動。
- **圖示**：ETF 存股用 `ti-chart-pie`（原本和存款都是小豬，使用者嫌重覆）；存款 `ti-pig`、個股買賣 `ti-chart-candle`、股票質押 `ti-building-bank`、信用貸款 `ti-credit-card`、訊號監控 `ti-activity`。
- **快速新增**（2026/11 使用者要求，右下角浮動「＋」`#qaFab`，<992px 才有、問 AI 頁隱藏）：按下開 `#qaWrap` 彈出層，`openQA()` 把「新增」分頁的 `#txForm`／`#divForm` 搬進 `#qaBody`（`closeQA()` 搬回原位，hashchange／Esc／點背景都會關），沿用原本的 submit 處理；快速新增時 submit 不改 `sym`、存完重畫目前這一頁；`renderHeader()` 在 `qa.open` 時不覆寫代號欄。代號欄下 `qaSugg()` 依代號或名稱建議，帳本沒有的代號提示「新代號」。手續費維持預設 20（不記上一筆，免得套錯）。往下捲時「＋」加 `.away` 讓開（免得擋到圖表拖曳條），往上捲或回頂端再出現。
- **首頁風險摘要** `#riskCard`（`renderRisk()`，由 `renderSecCards()` 呼叫；只在投資總覽首頁）：質押最低維持率（`brokerSummary()`／`loanCalc()`、`pct2()`、`ratioLevel()` 文字，群益缺價且沒有券商數字時略過）＋下一筆要付（信貸 `creditCalc().next`、略過 `creditPaidOn`；`repays` 未來日期的），點了去質押券商頁／信貸／繳息紀錄。電腦儀表板 grid area `risk`。
- **手機底部導覽列**（`#bnav`，<768px 才出現；上方 `.view-nav` 和頁首「功能表」`#menuWrap` 在手機隱藏）：投資／質押／訊號／AI／功能（2026/11 使用者要求把不常看的信貸、存款收進「功能」），按了等於點上方對應的頁籤 radio；「功能」`#bnavMoreBtn` 往上彈出 `#bnavMore`（信用貸款、存款〔`data-go`，名稱跟著 `#bnavSavLbl`〕、交易紀錄（全部）、貼上匯入、設定〔`data-menu`，等於點 `#menuPop` 同一項〕），在這五頁時「功能」亮起；選單打開時 body 加 `.more-open` 藏起快速新增「＋」。**液態玻璃懸浮**（2026/11 使用者要求，CSS 區塊「手機底部導覽列：液態玻璃懸浮」放在手機橫向區塊之後才蓋得過）：導覽列離四邊 12px、圓角 28px，半透明漸層＋`backdrop-filter: blur(22px) saturate(180%)`、上緣高光（`::before`）與陰影，深色模式另一組顏色；`#bnavMore` 也是圓角玻璃；手機橫向置中、最寬 560px。body 底部留 88px（橫向 58px），toast、「＋」、問 AI 輸入框（`body .chat-input`）都往上移到玻璃列上方；`showView()` 同步亮起目前頁；手機 body 底部留 64px，toast 往上移。
- **問 AI**（`#chat`，2026/11 使用者要求：金鑰放 Cloudflare、用 Haiku（曾試換 Opus，使用者嫌太貴改回）、放底部分頁；**使用者已同意讓 AI 看全部資料，含家人存款**）：手機底部導覽列「AI」、電腦左側「問 AI」、平板頁籤 `vChat`。對話第一題時 `chatSummary()` 拍一份帳本摘要快照（今日漲跌、ETF 各檔與合計、已出清、買進三類、配息每月與待入帳與下次推估、個股合計與獲利／虧損前 10 與每年每月獲利、股票質押各筆與維持率與用借款買的股票、信貸、存款結餘與還沒登記的利息、進場訊號與買進預測、提醒，約 8 千字），整段對話都用同一份（只往後加、不改前面，提示快取才有效、思考區塊才不會失效），按「新對話」`#chatNew` 重拍。**查詢工具**：摘要以外的明細由 Claude 自己呼叫工具查，工具在瀏覽器執行（`chatTool(name, input)`，全部只讀，回傳一行一筆的精簡文字，超過 58,000 字截斷）：`get_transactions`（代號、日期區間、買／賣、資金來源、筆數）、`get_dividends`、`get_symbol_detail`（持股、損益、每年買賣與配息、ETF 每筆買進的含息報酬）、`search_symbols`、`get_loans`（各筆借款與還款紀錄）、`get_credit_loans`（攤還表）、`get_savings`（存款紀錄）、`get_price_history`（只有已抓日 K 的持有中 ETF 和 `TWII`：收盤、60均、RSI、K、J）；工具定義在 Worker 的 `CHAT_TOOLS`，兩邊名稱要一致（`TOOL_LABEL`）。`chatSend()` 一題最多跑 8 輪：`chatRound()` POST 到 Worker `/chat`（`{key, summary, messages}`，key＝SHA-256(`stock-ledger-chat:`＋同步密碼)，所以要先開雲端同步），讀 SSE 串流邊收邊顯示（`chatMd()` 簡易排版：先跳脫再處理粗體、標題、條列、表格）；`stop_reason: tool_use` 時把回答區塊（含 `thinking`＋`signature`、`tool_use`）原樣存進 `chat.msgs`，執行工具後把全部 `tool_result` 放在同一則 user 訊息送回，再問一次；畫面顯示「查詢○○中…」，答完在泡泡下標「查了：…」。工具參數是串流拼出來的 JSON（`eager_input_streaming`），解析不了或工具名稱不認得就回 `is_error`。出錯、`stop_reason: refusal`（顯示「不方便回答」）時把 `chat.msgs` 退回這題之前並把問題放回輸入框；`max_tokens` 加註被截斷。打開分頁時 `chatCheck()` 先 GET `/chat` 看股價服務是不是新版、有沒有設金鑰，沒有就顯示設定步驟（`CHAT_SETUP`）。Worker 端 `chat()`：模型固定 `claude-haiku-5-5`、`effort: low`、`max_tokens` 4096、串流、`tools: CHAT_TOOLS`；系統提示（`CHAT_SYSTEM`，繁體中文、先看摘要、需要明細用工具查、不替使用者做買賣決定、存款是家人寄放的且使用者同意查看）＋摘要放在 `system`，用最上層 `cache_control` 自動快取；檢查訊息格式（user 只能是文字或 tool_result、assistant 只能是 text／thinking／redacted_thinking／tool_use，最多 121 則、900 KB）；同步密碼雜湊第一組綁定（KV `chat:cfg`，只存雜湊與當天題數）（別組密碼會收到 403「已經被另一組同步密碼綁定」，網頁顯示 `CHAT_BOUND` 說明：比對兩台同步密碼，或到 Cloudflare KV 刪掉 `chat:cfg` 改綁），每天最多 `CHAT_DAILY`＝100 題，**只有新問題算題數**（送回工具結果的那幾輪不算），Claude 回錯時不算；金鑰在 Cloudflare Secret `ANTHROPIC_API_KEY`。Cloudflare 網頁編輯器只能貼單一檔案，所以 Worker 直接用 `fetch` 呼叫 Messages API（`anthropic-version: 2026-10-21`），沒用 SDK。Haiku 5.5 沒有伺服器端的拒答備援（不要加 `fallbacks`）。存款資料只在執行時送給 Claude，仍然不可寫進 repo。
- **秘書**（原名「對話記憶庫」，2026/11 改名；2026/11 使用者要求；設定頁「秘書」`#memForm`／`#memNow`／`#memOff`／`#memSavings`，程式在 `index.html` 最後的「秘書」區塊）：把帳本資料傳到使用者另一個網站「秘書」（https://chat-memory.comfort527.workers.dev，Cloudflare Worker＋D1），讓那邊的 Claude 回答股票問題（**那邊只能查，不能改帳本**）。`memPayload()` 送 `{v:1, at, summary: chatSummary(), names, holdings（每檔 symSummary＋positionRun 的 buyCost／sellIn）, txs、divs（陣列精簡格式）, loans_text、credit_text（直接用 chatTool 的 get_loans／get_credit_loans 文字）, savings_text?}`；**家人存款預設不傳**，勾 `#memSavings` 才連摘要裡的存款段落與 `get_savings` 一起傳。`memPush()` POST 到 `/api/ext/stock-ledger`，`Authorization: Bearer sl_…`（金鑰在秘書「設定 → 其他網站 → 股票帳本」產生，只存在這台瀏覽器 `stockLedger.memory`）；還沒抓到股價會先 `refreshQuotes()`。**金鑰跟著雲端同步**：存在帳本資料的 `memLink`（`{token, savings}`，在 `dataExtra` 裡、加密同步），`memAdopt()` 以它為準（有就採用並標 `linked`；沒有而這台是 linked＝別台按了停止，這台也清掉；舊的只存在本機的設定會 `memPublish()` 放進資料）；`applyCloudText()` 套用雲端資料後呼叫 `memAfterPull()` 立刻再傳。`save()` 後 15 秒（`memSoon()`）自動再傳；`refreshQuotes()` 成功且距上次傳送超過 30 分鐘也會傳。秘書只允許 `https://comfort527.github.io` 跨網域呼叫。改 `chatSummary()`／`chatTool()` 的輸出格式時，秘書那邊不用改（它把文字原樣交給 Claude）；改 `txs`／`divs` 欄位時要同步改 `memPayload()`。
- **長說明收合**：加 `.help-fold`（可設 `data-help-label`）的說明預設收起，前面自動插一顆「ⓘ 說明」`.help-toggle` 按鈕（目前用在訊號象限圖說明、買進預測說明、交易紀錄頁底部說明）。
- **全域搜尋**：頁首放大鏡 `#srchBtn` 開 `#srchWrap`，打代號或名稱（規則同個股搜尋，代號開頭的、持有中的排前面，最多 40 筆；沒打字列持有中的），↑↓／Enter 選，點了 `openEtf()` 進那一檔。
- **提醒**（`remindItems()`，只在打開網頁時檢查，不是手機推播；使用者不要行事曆）：① 持有中 ETF 的下次配息——`nextDivGuess()` 用最近幾次發放間隔中位數（月）推估，最後一筆配息已入帳且預估日前 7 天內（或已過）就提醒去登記；已登記未來配息就不提醒 ② 信貸 7 天內扣款（那一期手動登記了已繳日期就不提醒） ③ 股票質押 30 天內到期 ④ 存款利息還沒登記 ⑤ 股票質押登記了**未來日期**的繳息（`repays` 裡 `interest>0` 且日期晚於今天；2026/11 使用者要求，不設天數門檻，7 天內紅、其餘黃；當天登記的不算；「查看」開繳息紀錄 `pledgeSection='interest'`）。**分兩區**（2026/11）：日期在 7 天內或已過＝「這 7 天」，鈴鐺數字、搖動與首頁黃色橫幅只算這區；其餘收在 `<details class="remind-later">`「之後（N 件）」（這 7 天沒事時預設展開）。每項有「去登記／查看」；**沒有手動關閉**，提醒會一直留著，直到事情結束才自動消失（配息登記了、扣款日過了、借款到期日更新或還清、利息登記了）。
- 五個頁籤：**投資總覽**、**股票質押**、**信用貸款**、**存款**（頁籤名＝`savings.name`＋「存款」）、**訊號監控**。不論目前在哪一層，點頁籤（含再點一次目前的頁籤）都回到該頁籤最上層（重設 `ovSec`／`etfOpen`、`pledgeSection`／`pledgeBroker`、`creditDetail`）。網址 hash 對應頁面：
  `#overview`、`#etf`、`#stock`、`#etf-<代號>`（單一股票詳細頁）、`#pledge`、`#credit`、`#savings`、`#signal`、`#chat`、`#buys`、`#paste`、`#settings`。
- **進場訊號**（獨立頁籤「訊號監控」`#signal`；2026/11 使用者要求刪掉原本的「進場訊號」清單卡片（`#sigCard`），頁面只留「現在離進場多近」象限圖，更新時間 `#sigTime` 移到它的標題列；進頁時 `renderSignals()`（只更新時間並呼叫 `drawSigViz()`）並補抓當天日 K；判斷用 `signalCalc()`）：監控對象＝`heldEtfs()`＝持有中的 ETF 扣掉 `SIG_SKIP`（2026/11 使用者不再關注 00712、00773B；象限圖、買進預測、提醒、問 AI 摘要、日 K 抓取、Telegram 代號清單都跟著它）。持有中的 ETF 條件＝收盤（盤中用現價）低於 60均、RSI(6)<20（Wilder 平滑）、K<20、J<0（KD 9,3,3，J＝3K−2D）；大盤條件＝加權指數 RSI(6)<20、J<0。日 K 一天抓一次存 `stockLedger.signal`（`loadSignalBars()`），盤中每分鐘用即時報價當今天這根重算（`liveBars()`）；全部成立時列入提醒鈴鐺。**Telegram 通知**（網頁沒開也收得到）：設定頁「Telegram 通知」區（`#tgTest`／`#tgRebind`／`#tgStatus`，`tgCall()`）把持有中 ETF 代號（只有代號）POST 到 Worker `/notify`，用 SHA-256(`stock-ledger-notify:`＋同步密碼) 當金鑰辨認使用者（Worker 只存它的雜湊，第一組綁定後別的密碼改不了，所以要先開雲端同步）；持股代號變了 `save()` 會經 `tgPushSoon()` 自動更新。Worker 的 `scheduled()`（Cron `*/5 1-5 * * 1-5`＝台灣週一到週五 9:00～13:55，程式內再限 13:40 前）用 `lastIndicators()`（和網頁 `indicatorSeries()` 同算法）＋即時報價判斷同樣條件，全部成立就用 Secret `TELEGRAM_TOKEN` 傳訊息，同一檔同一天只傳一次；設定存 KV `notify:cfg`（chat id 由 `getUpdates` 找最近私訊機器人的人），日 K 每天存 `notify:bars`（一次最多補 8 檔，避免超過子請求上限）。加權指數代號 `TWII`：Worker 的 `?s=TWII` 轉證交所 `tse_t00.tw`、`?k=TWII` 轉 Yahoo `^TWII`（FinMind 備援 `TAIEX`）。卡片另顯示美國 VIX（代號 `VIX`，Worker 的 `YAHOO_ONLY` 轉 Yahoo `^VIX`，`?s=` 用 `quoteYahoo()`、`?k=` 也支援；只供參考、不列入條件，15/20/30 分平靜／正常／緊張／恐慌；VIX 日 K 跟著 `loadSignalBars()` 一天抓一次）。清單上方是「現在離進場多近」卡片 `#sigVizCard`（`drawSigViz()`）：今天的 RSI(6)×K 象限圖（使用者 2026/11 指定縱軸改 K，0～100）。**兩軸分段放大**（2026/11 使用者要求）：0～20 佔前半段、20～100 佔後半段，進場區剛好佔左下 1/4；畫圖一律用 `pt(rsi, k)`／`sq()` 換算座標（點、拖尾、大盤十字線、進場區 markArea［0～50］、RSI 20／K 20 線［50］、點擊判斷），軸刻度每 12.5 一格、用 `unsq()` 標回實際數值（0、5、10、15、20、40、60、80、100）；提示框與標籤顯示實際值。**圓點外框**（2026/11 使用者要求，`ring()`／`inZone()`）：這檔 RSI、K 都 <20、大盤 RSI、K 也都 <20，**而且這檔的 RSI、K 都比大盤低**（在大盤藍色十字線的左下；使用者看實際畫面後補充）＝黑框（1.5px，使用者兩次嫌粗：3px→2px→1.5px）；只有這檔 <20＝紅框（1.5px，鮮紅 `#ff1a1a`，使用者要更紅更亮）；其餘白框（1px）；圖例的顏色點用同樣外框（box-shadow）。每檔一個實心小點（顏色依代號排序取 `SIG_COLORS`；使用者不要圈內代號、實心／空心、綠點等標示，嫌畫面亂），點後面有「錐形殘影」拖尾：custom 系列從前一天（`indicatorSeries()` 倒數第二天）的位置畫到今天的點，尾端半寬 0.6px、圓點端 6px，同色由透明漸層到 0.6（使用者選拖 1 天；拖 3 天、線＋空心圈的版本都看過不要）；條件成立越多畫在越上面；大盤不畫圈（使用者不要），只以大盤的（RSI、K）為中心畫藍色實線十字軸（大盤系列 `symbolSize:0` 的 `markLine`，標「大盤 RSI x」「大盤 K y」）。左下進場區（RSI<20 且 K<20）的紅色深淺跟著 VIX（12→40 對應 0.06→0.38 透明度），右邊是 VIX 溫度計（綠→灰→橘→紅，圓點標目前位置），右上角 VIX 數值。圖下 `#sigQuadLegend` 圖例：顏色點、「60均」「K」「RSI」「J」四個小燈、代號（代號放最後，長短不影響小燈對齊；`.sig-lg` 固定欄寬）。**點圖例某一列或圖上的圓點（點擊處手機 26px、電腦 16px 內最近的點；手機圓點 14px，用 zrender click＋`convertToPixel` 判斷）就只顯示那一檔**（`sigFocus`／`setSigFocus()`：圓點放大並標代號、RSI、K，其他圖例變淡，`#sigFocusBar` 顯示「只顯示 ○○・J 值」與「顯示全部」鈕）；再點同一檔、點圖上空白處或按「顯示全部」回到全部。（使用者不要時間軸熱度圖。）象限圖下面是**「買進預測」卡片** `#sigPredCard`（`renderSigPred()`／`nextDayNeed()`，由 `renderSignals()` 呼叫；**預設收合**，點標題 `#sigPredHead` 展開 `#sigPredBody`，不記住狀態，標題旁 `#sigPredSum` 顯示「N 檔有機會／都沒有機會」）：推算下一個交易日收盤要跌到多少，該檔四個條件才會全部成立。做法：以 `liveBars()` 最後一根（盤中＝現價）當今天收盤，假設隔天開平盤後一路跌、收在最低（最高＝今天收盤、最低＝收盤，是最容易成立的情況），用 `indicatorSeries()` 多帶出的 `ag`／`al`、`k`、`d` 往前推一天；每個條件都是價格越低越容易成立，所以在 ±10%（`LIMIT_PCT`，漲跌幅限制）內用二分法找剛好成立的價格，再往下取到 ETF 檔位（<50 元 0.01、其餘 0.05）。跌停也不成立顯示「完全沒有」並列出還差哪些條件；算出的價格高於目前價顯示「不用再跌，漲 x% 以內都成立」；每檔另標「最難的是哪個條件」。大盤（加權指數 RSI<20、J<0）用同樣算法列在最上面。依需要的跌幅由小到大排。指標由 `indicatorSeries()` 逐日計算（`indicators()` 取最後一天）；日 K 從約 420 天前抓起（`sigBars[s].from` 不夠早就重抓）。Worker 一次最多 30 檔（`MAX_SYMBOLS`）。
- **投資總覽**首頁：最上面是「今日漲跌摘要」`#todayCard`（`renderToday()`，由 `renderSecCards()` 呼叫）：持有中各檔 股數×（現價－昨收）加總與 %，列出賺最多兩檔、賠最多一檔；報價日期不是今天時標「最近交易日 MM/DD」。下面是「ETF 存股」「個股買賣」兩張大卡片（代號 00 開頭算 ETF），下方是獲利淨值變化圖。**ETF 配息日曆放在「ETF 存股」頁（`#etf`）、個股獲利日曆放在「個股買賣」頁（`#stock`）**，都在各檔卡片列表上方（個股有 300 多檔，放下方會被埋掉）；`renderDivCal()`／`renderProfitCal()` 只在對應頁面才畫。日曆有每月／全部期間，預設每月；ETF 配息日曆另有「每週」（`renderDivWeek()`：選定年份約 52 週直條，星期一開頭、含 1/4 的那週為第一週，週的年份與月份標示以星期四為準，累積平均改用 `divMAWeek()` 每週計），上一年／下一年同每月。ETF 配息日曆的直條上有藍色實線「累積平均」（`divMA()`：從第一筆配息月份到當月的配息總額含待入帳 ÷ 經過月數，最後一筆資料或本月之後不畫），每月與全部期間都有。拖曳各圖下控制條可調整月份區間，上方年度金額與統計同步更新；點年度金額會將圖表與控制條縮到該年，點月份直條看每日日曆。兩張日曆的模式、月份、拖曳範圍互相獨立；按「全部期間」會重設完整範圍。點投資卡片進入各檔卡片列表（個股列表用精簡卡片 `.sym-chip.compact`：代號名稱和「已實現、報酬（含息）」同一排；上方排序列 `#stockSortBar` 有搜尋框 `#stockSearch`（代號或名稱包含輸入文字就顯示，`#stockSearchInfo` 顯示找到幾檔；手機版搜尋框獨佔一行），排序可選股號／買進日期／賣出日期／獲利（已實現），預設獲利大到小，再點同一鈕反向，日期用該檔最近一次買進／賣出日（`lastTradeDate()`）並顯示在卡片上、沒有該類交易的排最後；選擇存在 `stockLedger.stockSort`），再點進單一股票詳細頁（統計卡、日 K 線、圖表、年度統計、紀錄、新增）。ETF 的紀錄表每筆買進顯示「報酬率（含息）」與價差（`lotReturns()`）：賣出依各筆剩餘股數比例扣、賣出實收照比例分（同平均成本法）；已入帳配息依除息日（沒有就用發放日）前各筆剩餘股數比例分實收金額，賣完後才發的配息依最後一次賣出前的股數分；報酬＝（剩餘股數×現價＋分到的賣出實收［＋配息］－買進總金額）÷買進總金額。各筆加總會等於該檔的含息報酬（扣掉待入帳配息）。每筆另顯示「賺／損 ○○ 元」（含息損益金額 `gain`，`gainTxt()`），表格用 `lotCell()`、手機清單用 `lotLine()`；同樣的欄位也出現在「買進紀錄」頁（`renderBuys()`，ETF 的買進才有，`#buyInfo` 另加篩選範圍內的含息損益合計，`#buyRetNote` 說明）。（「買進紀錄」頁 2026/11 改名「交易紀錄」，網址仍是 `#buys`）**買進分三類**（2026/11 使用者要求）：買進（自有資金，藍）、質押買進（`fund:'pledge'`，青）、配息滾入（`fund:'pledgeDiv'`，綠），每筆只掛一個標籤（`fundBadge()`／`kindBadge()`，買進紀錄頁與單一股票紀錄表都一樣）；買進紀錄頁篩選下拉 `#buyFund` 改成同樣三類＋「配息」＋只看賣出（選「配息」時 `renderBuyDivs()` 改列範圍內每一筆配息：發放日、代號、已入帳／待入帳、每股、除息日、實收，`#buyInfo` 顯示筆數、已入帳／待入帳／今年合計，「新增買賣」鈕變「新增配息」開配息表單；2026/11 使用者要求），上方 `#buyCats` 三格小計（各類投入金額、筆數、張數、含息賺損與報酬率，算目前範圍內全部買進、不受類別篩選影響；範圍內有質押或配息滾入才顯示），點一格只看那一類、再點一次看全部。日 K 線除了買入均價（藍）、含息均價（橘），每筆賣出畫紅色倒三角（賣出日、成交價），並有紅色「賣出均價」水平線（依股數加權）。
- **獲利日曆**：`stockProfitEvents()` 只處理個股。每筆賣出損益＝賣出實收－`positionRun()` 平均成本法算出的對應成本，歸在賣出成交日；配息依發放日歸類，待入帳配息另列、不計入獲利，未實現損益不列入。虧損保留負數；月內買賣淨損益為 0 仍保留可點直條。金額一萬以上用「123.5萬」寫法（`profitMoney()` 用 `wan1()`）。
- **獲利淨值變化（原「總體資產變化」，使用者已確認 2026/11 新口徑）**：首頁日曆下方的週蠟燭＝**獲利淨值**＝ETF 市值－ETF 目前持股成本＋ETF 已實現損益（賣出實收－平均成本）＋ETF 已入帳配息（依發放日）＋個股累積獲利。**扣除借款後淨值**（只在摘要、提示與明細顯示數字，不畫折線）＝ETF 市值＋個股累積獲利－當日借款餘額（不另加 ETF 已實現與配息：這些錢多半已再買進、反映在市值，加了會讓再投入的配息重複計算）。「投資部位（ETF 市值＋個股獲利）」只在摘要、提示與明細中顯示，不畫蠟燭。借款餘額由 `debtEvents()` 依日期還原：股票質押在起息日（沒有就解析 `startNote` 的日期）借入 `max(origAmount, amount＋已還本金)`，還款日減少，結清／展延日（解析 `closedNote` 日期，或最後一筆還款日）歸零；信貸依 `amortize()` 攤還表，錨點前的期數從原貸額線性推到錨點餘額。借款利息不扣。個股獲利沿用 `stockProfitEvents()`（已實現買賣損益＋已入帳配息）。蠟燭用左側 Y 軸；計算明細可核對各項。蠟燭用同週每日估值的首筆／末筆／最高／最低彙整，並非盤中高低；本週未結束標「進行中」。可選近 13／26／52 週或全部、拖曳與更新股價；缺價週留空。摘要另有「自高點跌落 X%」（目前值 ÷ 所選期間每日估值最高點 − 1，附高點日期與金額）與「創新高 +X%」（比前高多幾 %；週末沒新股價、和前一交易日同值的不算）或「再漲 +X% 創新高」；圖上有灰色虛線標出高點。歷史股價只需 ETF 與交易日參考 0050，用既有 Worker `?k=`，最多 3 檔並行、另存精簡快取（`.assetsHistory`）。金額先用萬分之一元精度累加再取整。
- **手機首頁收合**：小於 768px 時，ETF、個股卡片預設收合（兩張日曆與獲利淨值圖一律展開、不收合），可各自展開；狀態記在 `.collapsed` 的 `home-etf`、`home-stock`。投資卡片收合時保留名稱、檔數與市值，點名稱仍可進列表；圖表展開後才繪製。電腦版一律顯示完整內容。
- **股票質押**：首頁有借款、再投資（標記為質押的買進統計）兩張卡片。借款內有券商卡片（再進每筆借款、還款紀錄；券商頁的「整戶維持率」卡片可輸入擔保品跌幅 `riskDrop`，用 `riskAt()` 試算跌後維持率、碰線筆數與要先還多少本金回到 140%，元大逐筆、群益整戶）與繳息紀錄卡片；繳息紀錄返回借款頁。
- 再投資「用借款買的股票」表：買入均價＝質押部位剩餘成本÷股數；含息均價＝（剩餘成本－該部位已入帳配息）÷股數，未扣借款利息。沿用現有資金／除息日前持股分攤，用四捨五入前數字計算；已無持股顯示「—」，手機版均價顯示在每檔下一行。
- **存款**：結餘、累計利息／存入／提款、結餘階梯圖、「新增紀錄」「存提紀錄」兩張卡片預設收合（`savOpen`，點頁籤會重設；按鉛筆修改時自動打開表單）；已拿掉設定與貼上匯入（名字、利率、貼上只在沒有紀錄時的初始畫面出現）。存提紀錄表新的在上。利息＝月底結餘×年利率÷12 無條件進位，下個月 1 日入帳；`savCalc()` 把每筆利息配給「該月最後 3 天～下個月底」的月份，沒配到的過去月份列為「還沒登記」並可一鍵登記。
- **信用貸款**：首頁顯示總覽，點「信貸餘額合計」才顯示各家信貸明細與攤還表，可返回總覽。
- 年化報酬率：ETF 用 XIRR；個股以「最高同時投入資金」計算（短線交易用 XIRR 會失真）。

- **字的清楚度**（2026/11 使用者要求）：淺色模式的次要灰字 `--tblr-secondary` 調深成 `oklch(48% 0 0)`（深色模式仍用 gray-400）；卡片說明 `.kv-label`／`.kv-sub`／風險摘要／`.sec-n`／三類小計等從 12px 改 13px，最小的 11px（各檔卡片日期與標籤、首頁小方格、維持率刻度）改 12px。

- **手機數字鍵盤**（2026/11 使用者要求）：`numPads()` 幫所有 `input[type=number]` 加 `inputmode`（step 有小數點或 any＝`decimal`，其餘＝`numeric`），開頁時跑一次，之後用 MutationObserver 補上動態產生的輸入框。
- **手機下拉更新**（2026/11 使用者要求，只在手機外觀 `isPhone()`）：頁面在最上面（`scrollY` 0）時往下拉，`#ptr` 小膠囊跟著出現，拉超過 `PTR_GO`（64，手指移動 128px）放開就 `pullRefresh()`：重抓股價、有開同步就同步一次、在訊號頁再重抓日 K，完成顯示「已更新・時間」或股價錯誤。從圖表、輸入框、可捲動表格開始拉、彈出層／選單／確認視窗開著時不觸發；手機 CSS 加 `overscroll-behavior-y: contain` 關掉瀏覽器自己的下拉重新載入。

## 開發與測試

- 改程式時用小步驟、保留現有寫法與中文註解風格。
- 測試方式：用 Playwright 開 `index.html`（`file://`），分別用 1280 和 390 寬度檢查：沒有 `pageerror`、`document.documentElement.scrollWidth` 等於視窗寬度、關鍵文字正確。測試腳本和截圖放在暫存資料夾，**不要放進 repo**。
- 股價、K 線、同步、Telegram 通知都經過 Worker。修改 `worker/price-worker.js` 後，要請使用者把整份程式貼到 Cloudflare 的 `stock-price` → Edit code → Deploy（KV 綁定變數名稱是 `LEDGER`）。
- 改完：commit（訊息用繁體中文說明改了什麼）→ `git push origin main`。

## 已知待辦／注意事項

- **效能**（約 4,700 筆交易）：`symSummary`／`secSummary` 結果用 `memo()` 暫存，`save()`、`load()`、抓到新股價時 `bustCalc()` 清掉（鍵也帶 txs／divs 筆數）；`txsOf`／`divsOf` 依代號分組；`cssVar` 依主題快取；數字格式器 `nf()` 共用；單一股票詳細頁的 renderStats／Years／DivYears／Records 只在 `etfOpen` 時畫；換頁只 resize 看得到的圖表。**改資料一定要呼叫 `save()`**，不然暫存不會更新。`save()` 結尾通知同步／Telegram／秘書的三個呼叫各自包 try：`load()` 開頁時可能存檔，那時 `memCfg` 等後面宣告的變數還不能用，曾因此讓 `load()` 丟錯、改用內建資料。
- 群益擔保品裡的 2352 佳世達、6962 奕力-KY、1795 美時沒有買進紀錄，只有配息。
- 部分個股交易金額對不上（融資成數不同、零股、對帳單打錯），已照表上金額登錄，損益以「賣金－買金」為準。
- 信用貸款資料寫死在 `CREDIT_LOANS`，利率變動時要手動改。
