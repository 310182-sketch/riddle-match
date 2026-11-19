# 謎友｜陌生人猜謎配對

一個以主題引導的陌生人猜謎網站雛形。玩家配對後輪流出題和猜題，猜題者可以在聊天室自由提問。

## 目前版本

這是可部署到 GitHub Pages 的前端展示原型，包含角色抽選、主題、自由提問、提示、答案提交、五分鐘倒數和換角流程。配對對象、對話和答案判定由瀏覽器內的示範流程模擬；不同訪客目前不會進入同一個遊戲房間。

產品規劃與實作經驗記錄在 `knowledge/plan.md`、`knowledge/experience.md` 和 `knowledge/decision.md`，會和網站原始碼一起納入 GitHub repository。

## 本機預覽

直接用瀏覽器開啟 `site/index.html` 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 包含 `.github/workflows/pages.yml`。將預設分支推送到 GitHub 後，workflow 會把 `site/` 發布到 GitHub Pages。

第一次部署前，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。部署完成後，可在同一頁查看網站網址。

## 後續工作

- 接上即時配對、多人聊天室和遊戲房間狀態服務。
- 加入玩家離開、重新配對、逾時及安全機制。
- 確認出題者的自由回答方式和猜中後的換題規則。
