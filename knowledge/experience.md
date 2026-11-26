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

## GitHub Actions runner 執行環境警告

- **經驗：** 部署 action 即使尚能執行，也可能先出現執行階段棄用警告；部署失敗時應查看失敗步驟的 annotation，再區分警告和真正錯誤，並參照官方 release 更新主要版本。
- **適用範圍：** 使用 GitHub Actions 的網站部署與持續整合 workflow。
- **本專案做法：** Pages workflow 從 checkout v4、configure-pages v5、upload-pages-artifact v3 和 deploy-pages v4 更新至查得的目前主要版本；首次失敗的實際原因是 Pages 在 workflow 啟動時尚未啟用。

## 即時遊戲狀態與答案保護

- **經驗：** 靜態前端中的答案只適合展示原型；任何送到瀏覽器的程式與資料都能被玩家檢視。真人遊戲應由伺服器保管謎底並判定答案，伺服器也應作為計時與回合切換的權威來源。
- **適用範圍：** 有隱藏答案、競賽結果、倒數或多位玩家共享狀態的瀏覽器遊戲。
- **本專案做法：** 單機展示版以 JavaScript 模擬答案判定；出題者輸入謎題和謎底的介面可展示流程，但答案目前仍會送到瀏覽器。接上真人配對服務前，需把謎底和回合狀態移到後端。

## 使用 RLS 保護房間內的祕密欄位

- **經驗：** Postgres Row Level Security 控制資料列的讀取，不會隱藏同一列中的個別欄位。若兩位房間玩家都能讀取房間資料列，將答案放在該列就會把答案一併暴露給猜題者。應將答案放進獨立資料表，以 RLS 限制直接讀取，再用檢查房間角色的 RPC 執行答案判定及逾時揭曉。
- **適用範圍：** 多位使用者共享遊戲房間，但其中只有部分角色可讀取答案、提示或其他私有資料的應用。
- **本專案做法：** `match_rooms` 只存可供雙方閱讀的謎題和狀態；`room_secrets` 保存答案和提示。猜題者透過 `submit_guess` 只取得正誤結果，逾時後再由 `end_expired_round` 取得答案。此遷移尚待套用至 Supabase project 並核對權限。

## 以資料庫交易鎖保護配對佇列

- **經驗：** 多個配對請求可能同時選取同一位等待者。將配對選擇、刪除佇列項目和建立房間放在單一資料庫 RPC 交易內，並用交易層級鎖序列化佇列操作，可避免兩個請求都配走同一位玩家。取消等待也必須使用相同鎖，才能處理配對與取消同時發生的情況。
- **適用範圍：** 多用戶佇列、工作領取或其他要求同一資源不可被同時分配兩次的資料庫流程。
- **本專案做法：** `join_matchmaking` 和 `cancel_matchmaking` 共用交易層級 advisory lock，配對在同一個交易中刪除雙方等待項目並建立房間；取消請求亦會結束剛完成配對的房間。

## 靜態網站的選用式即時後端

- **經驗：** 靜態展示頁面可以保留作為無設定的本機預覽，同時提供可選的即時後端模式。只有明確填入公開服務 URL 與用戶端 key 時才載入即時服務 SDK；空白設定繼續走展示流程。公開 key 仍必須依賴 RLS，不可當作祕密或授權檢查。
- **適用範圍：** 需要以靜態網站主機逐步接入託管式即時服務，且希望開發預覽不依賴服務設定的產品原型。
- **本專案做法：** `site/boot.js` 依 `site/supabase-config.js` 選擇真人流程或示範流程。前端設定只預留公開 URL 與 key，真人模式仍待實際部署及跨訪客驗證。

## 靜態網站的憑證邊界

- **經驗：** GitHub Pages 發布的前端內容是公開可讀的，不可把 Personal Access Token、服務角色金鑰或其他伺服器祕密放進 HTML、JavaScript、建置產物或公開 repository。
- **適用範圍：** GitHub Pages 或其他靜態主機搭配第三方後端服務的網站。
- **本專案做法：** 尚未加入任何服務金鑰；選定即時後端後，前端只使用允許公開的用戶端設定，並由後端存取規則保護房間和資料。

## GitHub 網頁登入與本機 Git 授權

- **經驗：** 在瀏覽器登入 GitHub 不會自動為 Git 命令列設定 push 權限；Windows 上可使用 Git Credential Manager 完成一次 OAuth 授權，避免把 Personal Access Token 貼進聊天或原始碼。
- **適用範圍：** 使用 Git for Windows 從本機建立遠端 repository、push commit 或查詢 GitHub Actions 時。
- **本專案做法：** 透過 Git Credential Manager 授權 `310182-sketch`，設定本機 repository 使用 `manager` helper，再建立 `origin` 並推送。
