# 謎友｜陌生人猜謎配對

一個以主題引導的陌生人猜謎網站雛形。玩家配對後輪流出題和猜題，猜題者可以在聊天室自由提問。

## 目前版本

這是可部署到 GitHub Pages 的前端展示原型，包含主題、自由提問、提示、答案提交、五分鐘倒數和換角流程。未設定 Supabase 時，配對對象、對話和答案判定由瀏覽器內的示範流程模擬；不同訪客不會進入同一個遊戲房間。

## 真人配對後端（尚未啟用）

Repository 已包含 Supabase 資料庫遷移及選用的真人配對前端。要啟用真人模式，請先依 `supabase/README.md` 建立 Supabase project、啟用匿名登入並套用遷移，再將 project URL 和公開用戶端 key 填入 `site/supabase-config.js`。該設定檔會公開給所有網站訪客，請勿放入 service-role key 或其他祕密。設定未完成時網站會繼續載入展示版。

產品規劃與實作經驗記錄在 `knowledge/plan.md`、`knowledge/experience.md` 和 `knowledge/decision.md`，會和網站原始碼一起納入 GitHub repository。

## 本機預覽

直接用瀏覽器開啟 `site/index.html` 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 包含 `.github/workflows/pages.yml`。將預設分支推送到 GitHub 後，workflow 會把 `site/` 發布到 GitHub Pages。

第一次部署前，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。部署完成後，可在同一頁查看網站網址。

## 後續工作

- 部署並驗證 Supabase 遷移，為真人模式設定 Supabase 專案。
- 完成真人配對的離線、重新配對及玩家安全流程。
- 在兩個不同訪客間確認一整局遊戲可正常進行。
