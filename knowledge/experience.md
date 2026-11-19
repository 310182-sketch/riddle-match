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

## 即時遊戲狀態與答案保護

- **經驗：** 靜態前端中的答案只適合展示原型；任何送到瀏覽器的程式與資料都能被玩家檢視。真人遊戲應由伺服器保管謎底並判定答案，伺服器也應作為計時與回合切換的權威來源。
- **適用範圍：** 有隱藏答案、競賽結果、倒數或多位玩家共享狀態的瀏覽器遊戲。
- **本專案做法：** 單機展示版以 JavaScript 模擬答案判定；出題者輸入謎題和謎底的介面可展示流程，但答案目前仍會送到瀏覽器。接上真人配對服務前，需把謎底和回合狀態移到後端。

## 靜態網站的憑證邊界

- **經驗：** GitHub Pages 發布的前端內容是公開可讀的，不可把 Personal Access Token、服務角色金鑰或其他伺服器祕密放進 HTML、JavaScript、建置產物或公開 repository。
- **適用範圍：** GitHub Pages 或其他靜態主機搭配第三方後端服務的網站。
- **本專案做法：** 尚未加入任何服務金鑰；選定即時後端後，前端只使用允許公開的用戶端設定，並由後端存取規則保護房間和資料。

## GitHub 網頁登入與本機 Git 授權

- **經驗：** 在瀏覽器登入 GitHub 不會自動為 Git 命令列設定 push 權限；Windows 上可使用 Git Credential Manager 完成一次 OAuth 授權，避免把 Personal Access Token 貼進聊天或原始碼。
- **適用範圍：** 使用 Git for Windows 從本機建立遠端 repository、push commit 或查詢 GitHub Actions 時。
- **本專案做法：** Git Credential Manager 已安裝但目前未授權；完成帳號授權後再建立遠端 repository 並推送。
