# 同頻｜二選一共同點遊戲

透過同一主題的二選一問答，讓兩位玩家發現共同點。雙方各自回答每一題，完成後才揭曉答案。

## 原型目前包含

- 選擇旅行、音樂、日常或飲食主題，也可以隨機選題。
- 使用一次性的暱稱進入示範配對，不需要註冊。
- 具備 Supabase Auth client、邀請房、隨機配對、真人雙人答題、歷史查詢和共同點統計的前端接線；有 Supabase 專案設定時走真人 RPC，沒有設定時保留明確標示的本機示範。
- 真人對局提供檢舉及封鎖入口，歷史頁可管理封鎖清單；隱私說明列出資料用途和保存期限。此原型尚無人工審查人員，檢舉不代表即時有人處理。
- 完成五題二選一，逐題揭曉雙方答案並查看共同選擇。
- 匯出 1080×1920 結果分享卡；可呼叫系統分享面板或下載 PNG。Instagram 交接仍需用實機確認。
- 可在手機與桌面瀏覽器操作。

目前工作區沒有 Supabase 專案 URL／公開 key，因此登入與真人服務入口停用，使用者只能玩本機示範。三份資料庫 migration 已在 PGlite 預檢環境套用，並驗證主要遊戲、安全 RPC、資料存取限制、帳號限量與檢舉保存期限；這不代表 Supabase 線上設定、Realtime、RLS 或跨裝置流程已驗證。

## Supabase Auth 設定

`site/supabase-config.js` 是公開用戶端設定範本。建立 Supabase 專案後，填入 project URL 和 anon／publishable key，並在 Dashboard 啟用 Anonymous Auth 及已完成設定的 provider：

- `google`、`facebook`、`x` 設為 `true` 後，分別使用 Supabase 內建 provider；程式將 X 對應至 Supabase 的 `twitter` provider ID。
- `instagram`、`threads` 填入 Supabase custom provider 的完整識別碼，例如 `custom:instagram`、`custom:threads`。只有在 Meta app 資格、審核與 Supabase custom OAuth 設定完成後才啟用。
- 在 Supabase Auth URL Configuration 加入本機 HTTP 預覽網址和正式 GitHub Pages 網址，provider callback 則使用 Supabase Dashboard 顯示的 callback URL。OAuth 不支援直接從 `file://` 開啟。

設定完成後的 `providers` 形式如下；只將已在 Supabase Auth 設定完成的 provider 打開：

```js
providers: {
  google: true,
  facebook: true,
  x: true,
  instagram: "custom:instagram",
  threads: "custom:threads"
}
```

瀏覽器以 Supabase JS v2.119.2 初始化匿名登入、OAuth、session 恢復及匿名帳號的 identity linking；CDN 檔案使用 SRI 固定完整性。未設定 URL／key 或 SDK 無法載入時，登入入口維持停用，示範流程仍可使用。登入尚未接上配對、歷史或統計服務。anon／publishable key 是公開用戶端設定；service role key 和各 provider client secret 僅能留在 Supabase 後端設定。

匿名帳號連結前，需在 Supabase Auth 設定中啟用 **Manual Linking**。OAuth redirect allow list 必須包含實際網站子路徑；本機應透過 HTTP localhost 預覽，而不是直接開啟 HTML 檔。

## 真人配對後端草稿

`supabase/migrations/` 收錄 Supabase PostgreSQL schema 與 RPC，包含隨機配對、12 位邀請代碼、雙人作答同步、玩家各自保存 90 天的對局摘要、共同點排名、封鎖／檢舉及服務端限量；房間、配對票券和原始作答最多保留 24 小時，檢舉保存 180 天。三份 migration 已在本機 PGlite 預檢環境套用；這不代表已部署至 Supabase，也不驗證 Supabase Auth、Realtime、pg_cron 或線上 RLS。正式連接前須建立 Supabase 專案、啟用匿名登入、依序套用並驗證 migration、確認 RLS／Realtime／RPC 權限與清理排程，再設定公開用戶端 URL 與 anon key。不要將 service role key 放進靜態網站。

## 本機預覽

直接用瀏覽器開啟 site/index.html 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 的 `.github/workflows/pages.yml` 會將 `site/` 發布至 GitHub Pages。推送 `main`、`master` 或 `codex/commonality-quiz-prototype` 時 workflow 會觸發；目前 GitHub 的 `github-pages` environment 保護規則拒絕此功能分支，因此尚未部署。需在 repository environment 允許此分支後重跑 workflow；第一次部署前也需將 Pages source 設為 **GitHub Actions**。

## 文件

- knowledge/plan.md：產品願景、現況與路線圖。
- knowledge/experience.md：適用範圍明確的實作經驗。
- knowledge/decision.md：目前原型採用的預設和待確認事項。

## 下一步

- 建立 Supabase 專案並填入 `site/supabase-config.js`，啟用 Anonymous Auth，套用並驗證 migration、RLS、Realtime 和資料清除排程；設定 Facebook、Google、X，並依 Meta 審查結果評估 Instagram、Threads custom OAuth。
- 將前端示範流程接上真人配對 RPC，並用兩個不同裝置走完整局。
- 在 iOS／Android 實機與 VoiceOver／TalkBack 檢查無障礙操作，收集玩家回饋。
- 建立人工檢舉審查、玩家聯絡及緊急升級流程；完成前不得宣稱檢舉有人即時處理。
- 在正式 Supabase 專案和兩部不同裝置驗證 Auth、migration、RLS、Realtime、清理排程、封鎖及檢舉。
- 依公開服務地區覆核隱私告知與資料保存政策，並做行動裝置及讀屏檢查。
