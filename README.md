# 同頻｜二選一共同點遊戲

和陌生人玩同一主題的二選一問答。雙方各自回答每一題，作答完成後立即揭曉答案，看看彼此有哪些共同點。

## 原型目前包含

- 選擇旅行、音樂、日常或飲食主題，也可以隨機選題。
- 使用一次性的暱稱進入示範配對，不需要註冊。
- 完成五題二選一，逐題揭曉雙方答案並查看共同選擇。
- 匯出 1080×1920 結果分享卡；可呼叫系統分享面板或下載 PNG。Instagram 交接仍需用實機確認。
- 可在手機與桌面瀏覽器操作。

這是純前端互動原型。配對對象和對方答案由瀏覽器內的範例資料模擬；沒有真人配對、帳號服務、聊天室或遊戲紀錄，也不會保存暱稱。畫面會持續標示示範模式。

## 真人配對後端草稿

`supabase/migrations/` 收錄 Supabase PostgreSQL 的第一版 schema 與 RPC migration，包含匿名玩家配對、房間同步、雙方作答後揭曉及短期資料清除。這份 migration 尚未套用到 Supabase 專案，也沒有連接目前的前端；目前網站仍是示範模式。正式連接前須建立 Supabase 專案、啟用匿名登入、套用並驗證 migration、排程清除函式，再設定公開用戶端 URL 與 anon key。不要將 service role key 放進靜態網站。

## 本機預覽

直接用瀏覽器開啟 site/index.html 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 的 .github/workflows/pages.yml 會將 site/ 發布至 GitHub Pages。推送 main、master 或 `codex/commonality-quiz-prototype` 分支時，workflow 會自動執行；目前原型分支可獨立發布，不需先覆蓋遠端 `main`。第一次部署前，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。

## 文件

- knowledge/plan.md：產品願景、現況與路線圖。
- knowledge/experience.md：適用範圍明確的實作經驗。
- knowledge/decision.md：目前原型採用的預設和待確認事項。

## 下一步

- 在 Supabase 專案套用並驗證 migration、RLS、匿名登入、Realtime 和資料清除排程。
- 將前端示範流程接上真人配對 RPC，並用兩個不同裝置走完整局。
- 在 iOS／Android 實機與 VoiceOver／TalkBack 檢查無障礙操作，收集玩家回饋。
- 真人 MVP 上線前完成檢舉、封鎖、離線處理及匿名帳號濫用風險規劃。
