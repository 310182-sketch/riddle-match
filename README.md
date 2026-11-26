# 謎友｜陌生人猜謎配對

一個以主題引導的陌生人猜謎網站雛形。玩家配對後輪流出題和猜題，猜題者可以在聊天室自由提問。

## 目前版本

這是可部署到 GitHub Pages 的前端原型，包含主題、自由提問、提示、答案提交、五分鐘倒數和換角流程。未設定真人後端時，配對對象、對話和答案判定由瀏覽器內的示範流程模擬；不同訪客不會進入同一個遊戲房間。

## 真人配對後端

真人模式使用 Neon PostgreSQL 和 Neon Functions，以匿名遊戲 session 及短輪詢同步房間。程式與本機測試位於 `neon/`，部署與安全邊界見 `neon/README.md`；指定 Neon 分支已套用資料庫遷移並部署 Functions，網站設定為使用該 API。網站由 GitHub Pages 提供，Neon 負責資料與後端 API。

`site/neon-config.js` 只包含公開 Function URL。設定檔會公開給所有訪客，絕不可放入資料庫連線字串、密碼或其他祕密。設定留白時保留展示模式；先前的 Supabase 原型保留在 `supabase/` 作為參考。

產品規劃與實作經驗記錄在 `knowledge/plan.md`、`knowledge/experience.md` 和 `knowledge/decision.md`，會和網站原始碼一起納入 GitHub repository。

## 本機預覽

直接用瀏覽器開啟 `site/index.html`，或從 `localhost`／本機 loopback 位址提供網站，即可預覽展示模式，不需要安裝套件或建置工具；即使已設定正式後端，本機預覽預設也不會連線。

若要刻意測試真人連線，先以本機 HTTP 伺服器提供 `site/`，例如在 repository 根目錄執行 `python -m http.server 4173 --directory site`，再開啟 `http://localhost:4173/?online=1`。須先在 `site/neon-config.js` 填入要測試的公開 Function URL，並在該函式的 `ALLOWED_ORIGINS` 中允許 `http://localhost:4173`（保留其他仍需使用的來源）；參見 `neon/function/README.md`。直接以 `file://` 開啟的頁面通常無法通過後端 CORS，請用本機 HTTP 伺服器進行線上測試。

## GitHub Pages 部署

Repository 包含 `.github/workflows/pages.yml`。將預設分支推送到 GitHub 後，workflow 會先執行自動測試，再把 `site/` 發布到 GitHub Pages。

第一次部署前，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。部署完成後，可在同一頁查看網站網址。

## 後續工作

- 在指定 Neon 分支部署並核對資料庫權限、Functions 和資料保留。
- 完成真人配對的玩家安全流程，並在兩個不同訪客間驗證一整局遊戲。
