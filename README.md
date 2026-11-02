# 股票帳本

個人股票投資紀錄網頁：交易明細、配息紀錄、年度統計與圖表。

## 使用方式

- 直接打開 `index.html`，或透過 GitHub Pages 的網址使用。
- **這個公開版本不含任何個人資料**。第一次打開是空的，請用「匯入備份」載入自己的 JSON 備份檔，或從 Excel 貼上交易紀錄。
- 資料只存在你自己瀏覽器的 localStorage，不會上傳到 GitHub 或任何伺服器。換瀏覽器、換裝置或清除瀏覽資料後要重新匯入，請定期匯出備份。

## 功能

- 交易紀錄：新增、編輯、刪除、從 Excel 貼上，自動計算平均成本與年度統計
- 配息紀錄：實收金額、54C 股利所得、補充保費與可抵減稅額估算，有除息日和每股配息時會自動核對
- 圖表：累積投入成本 vs 累積實收配息、每年實收配息
- 深色模式、JSON 備份與 CSV 匯出

## 使用的套件（從 CDN 載入）

- [Tabler](https://tabler.io/)：版面與樣式
- [Tabler Icons](https://tabler.io/icons)：圖示
- [Apache ECharts](https://echarts.apache.org/)：圖表
