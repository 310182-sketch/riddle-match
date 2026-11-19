# 同頻｜二選一共同點遊戲

透過同一主題的二選一問答，讓兩位玩家發現共同點。雙方各自回答每一題，完成後才揭曉答案。

## 原型目前包含

- 選擇旅行、音樂、日常或飲食主題，也可以隨機選題。
- 使用一次性的暱稱進入示範配對，不需要註冊。
- 預覽隨機配對等待、建立邀請房、輸入房間代碼和歷史統計空狀態；這些介面目前不會連接其他裝置或保存資料。
- 完成五題二選一，逐題揭曉雙方答案並查看共同選擇。
- 匯出 1080×1920 結果分享卡；可呼叫系統分享面板或下載 PNG。Instagram 交接仍需用實機確認。
- 可在手機與桌面瀏覽器操作。

配對對象和對方答案由瀏覽器內的範例資料模擬；尚未連接真人配對、遊戲紀錄或統計，也不會保存暱稱。畫面會持續標示示範模式。首頁已加入可選的 Supabase Auth 入口；目前尚無專案設定，因此登入按鈕停用，示範遊戲仍可直接使用。

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

`supabase/migrations/` 收錄 Supabase PostgreSQL schema 與 RPC 草稿，包含隨機配對、12 位邀請代碼、雙人作答同步、玩家各自保存 90 天的對局摘要、共同點排名及房間原始資料 24 小時清除。Migration 尚未套用或驗證，也沒有連接目前的前端；目前網站仍是示範模式。正式連接前須建立 Supabase 專案、啟用匿名登入、依序套用並驗證 migration、確認 RLS／Realtime／RPC 權限與清理排程，再設定公開用戶端 URL 與 anon key。不要將 service role key 放進靜態網站。

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
- 真人 MVP 上線前完成檢舉、封鎖、離線處理及匿名帳號濫用風險規劃。
