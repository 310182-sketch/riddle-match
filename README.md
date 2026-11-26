# 謎友｜陌生人猜謎配對

一個以主題引導的陌生人猜謎網站雛形。玩家配對後輪流出題和猜題，猜題者可以在聊天室自由提問。

## 目前版本

這是可部署到 GitHub Pages 的前端原型，包含主題、自由提問、提示、答案提交、五分鐘倒數和換角流程。未設定真人後端時，配對對象、對話和答案判定由瀏覽器內的示範流程模擬；不同訪客不會進入同一個遊戲房間。

## 真人配對後端（尚未啟用）

真人模式以 Neon PostgreSQL 和 Neon Functions 為目標，使用匿名遊戲 session 及短輪詢同步房間。程式與本機測試位於 `neon/`，部署與安全邊界見 `neon/README.md`；指定 Neon 分支已套用資料庫遷移並部署 Functions，真人網站尚未啟用。網站仍由 GitHub Pages 提供，Neon 負責資料與後端 API。

只有完成後端部署與驗證後，才將公開 Function URL 填入 `site/neon-config.js`。設定檔會公開給所有訪客，絕不可放入資料庫連線字串、密碼或其他祕密。設定留白時保留展示模式；先前的 Supabase 原型保留在 `supabase/` 作為參考。

產品規劃與實作經驗記錄在 `knowledge/plan.md`、`knowledge/experience.md` 和 `knowledge/decision.md`，會和網站原始碼一起納入 GitHub repository。

## 本機預覽

直接用瀏覽器開啟 `site/index.html` 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 包含 `.github/workflows/pages.yml`。將預設分支推送到 GitHub 後，workflow 會先執行自動測試，再把 `site/` 發布到 GitHub Pages。

第一次部署前，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。部署完成後，可在同一頁查看網站網址。

## 後續工作

- 在指定 Neon 分支部署並核對資料庫權限、Functions 和資料保留。
- 完成真人配對的玩家安全流程，並在兩個不同訪客間驗證一整局遊戲。
