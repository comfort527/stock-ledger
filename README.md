# 股票帳本

個人股票投資紀錄網頁：ETF 存股、個股買賣、配息、股票質押借款、信用貸款。

> 接手開發（Codex 等 AI 助理）請先讀 [AGENTS.md](AGENTS.md)。

## 使用方式

- 直接打開 `index.html`，或透過 GitHub Pages 的網址使用。
- 網頁內建了我的 00878 交易與配息紀錄（第一次打開、瀏覽器裡還沒有資料時會自動載入）。
- 之後的新增、修改都存在瀏覽器的 localStorage，不會自動寫回 GitHub。換瀏覽器或裝置時，用「備份」匯出 JSON 再匯入。

## 功能

- 交易紀錄：新增、編輯、刪除、從 Excel 貼上，自動計算平均成本與年度統計
- 配息紀錄：實收金額、54C 股利所得、補充保費與可抵減稅額估算，有除息日和每股配息時會自動核對
- 圖表：累積投入成本 vs 累積實收配息、每年實收配息
- 深色模式、JSON 備份與 CSV 匯出

## 使用的套件（從 CDN 載入）

- [Tabler](https://tabler.io/)：版面與樣式
- [Tabler Icons](https://tabler.io/icons)：圖示
- [Apache ECharts](https://echarts.apache.org/)：圖表
