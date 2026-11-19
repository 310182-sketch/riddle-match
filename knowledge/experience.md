# 專案經驗

## GitHub Pages 適用於靜態前端

- **經驗：** GitHub Pages 會託管靜態檔案，適合先發布前端雛形；它本身不提供配對佇列、即時聊天室、共享遊戲狀態或答案驗證服務。
- **適用範圍：** 使用 GitHub Pages 發布需要多位訪客即時互動的網站時，先標示展示模式，再規劃獨立的即時後端或託管服務。
- **本專案做法：** 以瀏覽器內模擬流程呈現產品概念，真人配對列為後續路線圖項目。

## 專案型 Pages 部署

- **經驗：** 專案頁面通常部署在 `/<repository>/` 子路徑，HTML 引用 CSS、JavaScript 和圖片時使用相對路徑，可避免硬編碼網域根目錄造成資源 404。
- **適用範圍：** 發布至 `https://<owner>.github.io/<repository>/` 的靜態網站。
- **本專案做法：** 網站檔案集中在 `site/`，資源引用採相對路徑；Actions workflow 上傳 `site/` artifact，再交由 Pages 部署 action 發布。

## GitHub Actions 部署 Pages

- **經驗：** 使用官方 Pages actions 時，workflow 需要 `pages: write` 和 `id-token: write` 權限；repository 的 Pages source 需設為 GitHub Actions。
- **適用範圍：** 透過 GitHub Actions 將靜態檔案發布到 GitHub Pages。
- **本專案做法：** push 到 `main` 或 `master` 時執行部署，並保留手動觸發入口。
