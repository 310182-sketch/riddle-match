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

目前工作區沒有 Supabase 專案 URL／公開 key，因此登入與真人服務入口停用，使用者只能玩本機示範。五份資料庫 migration 已在 PGlite 預檢環境套用，8 項可重複執行的 migration 回歸測試涵蓋雙人作答、隨機配對、歷史分頁與默契排名、資料保留期限、服務端限量、安全 RPC 及刪除帳號時的資料收尾；這不代表 Supabase 線上設定、Realtime、RLS、Edge Function 或跨裝置流程已驗證。

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

瀏覽器以 Supabase JS v2.119.2 初始化匿名登入、OAuth、session 恢復及匿名帳號的 identity linking；CDN 檔案使用 SRI 固定完整性。未設定 URL／key 或 SDK 無法載入時，登入入口維持停用，示範流程仍可使用。配對、歷史及統計 RPC 已接入前端，但因尚無 Supabase 專案設定，真人登入和線上資料尚未驗證。anon／publishable key 是公開用戶端設定；service role key 和各 provider client secret 僅能留在 Supabase 後端設定。

匿名帳號連結前，需在 Supabase Auth 設定中啟用 **Manual Linking**。OAuth redirect allow list 必須包含實際網站子路徑；本機應透過 HTTP localhost 預覽，而不是直接開啟 HTML 檔。

### 自助刪除帳號

刪除帳號由 `supabase/functions/delete-account/` 的 Edge Function 執行：函式先驗證目前登入者，再以 Supabase 後端的 service role 刪除該使用者。資料庫會先關閉該玩家的進行中房間；玩家自己的歷史和封鎖關係會移除，其他玩家的歷史會匿名化，既有檢舉則解除帳號連結並保留至 180 天期限。靜態前端不會取得 service role key。

建立 Supabase 專案後部署函式，並將 `ALLOWED_ORIGINS` 設為逗號分隔的精確網站 origin（例如 `https://<owner>.github.io` 和本機 HTTP origin；不要附網站子路徑）。只有確認 Edge Function、secret 和 CORS origin 設定完成後，才在 `site/supabase-config.js` 設定 `accountDeletionEnabled: true`；範本預設為 `false`，避免顯示無法使用的按鈕。正式 origin 尚未確定前不要打開此開關。

```sh
supabase functions deploy delete-account
supabase secrets set ALLOWED_ORIGINS="https://<owner>.github.io,http://localhost:8000"
```

## 真人配對後端草稿

`supabase/migrations/` 收錄 Supabase PostgreSQL schema 與 RPC，包含隨機配對、12 位邀請代碼、雙人作答同步、玩家各自保存 90 天的對局摘要、共同點排名、封鎖／檢舉、服務端限量及帳號刪除清理；房間、配對票券和原始作答最多保留 24 小時，檢舉保存 180 天。五份 migration 已在本機 PGlite 預檢環境套用；這不代表已部署至 Supabase，也不驗證 Supabase Auth、Realtime、pg_cron 或線上 RLS。正式連接前須建立 Supabase 專案、啟用匿名登入、依序套用並驗證 migration、確認 RLS／Realtime／RPC 權限與清理排程，再設定公開用戶端 URL 與 anon key。不要將 service role key 放進靜態網站。

### 本機 migration 回歸測試

使用 Deno 與 PGlite 在本機建立暫存 PostgreSQL，依序套用所有 migration，檢查核心資料流程和資料權限：

```sh
deno test --allow-read --allow-net supabase/tests/migrations.test.ts
```

8 項測試涵蓋雙人作答揭曉與歷史摘要、主題相容的隨機配對和封鎖／取消、歷史游標分頁與 90 天範圍、至少三局的共同點排名、24／90／180 天清理、配對及開房限量、檢舉去重與封鎖，以及刪除帳號時關閉房間並解除檢舉雙方的帳號連結。這些測試使用最小 Auth／角色 stub，不能取代 Supabase 專案中的 Auth、Realtime、pg_cron、RLS 和跨裝置驗證。

## 本機預覽

直接用瀏覽器開啟 site/index.html 即可預覽，不需要安裝套件或建置工具。

## GitHub Pages 部署

Repository 的 `.github/workflows/pages.yml` 會將 `site/` 發布至 [GitHub Pages](https://310182-sketch.github.io/riddle-match/)。`github-pages` environment 保留分支保護，允許 `main` 和 `codex/commonality-quiz-prototype` 部署。每次部署前，workflow 會先執行 Deno/PGlite 資料庫 migration 回歸測試、帳號刪除函式 request 測試及前端語法檢查；只有驗證通過後才進入部署 job，Pages 寫入與 OIDC 權限僅授予部署 job。workflow 已成功發布原型；公開網址回應 HTTP 200 並顯示遊戲頁標題。此網站目前是原型，尚未設定 Supabase URL／key，真人登入及後端服務未啟用。

## 文件

- knowledge/plan.md：產品願景、現況與路線圖。
- knowledge/experience.md：適用範圍明確的實作經驗。
- knowledge/decision.md：目前原型採用的預設和待確認事項。

## 下一步

- 建立 Supabase 專案並填入 `site/supabase-config.js`，啟用 Anonymous Auth 和 Manual Linking，依序套用五份 migration，並在專案內驗證 RLS、Realtime、RPC 權限和資料清除排程。
- 建立並設定 Facebook、Google、X provider app，驗證登入、callback、session 恢復和匿名帳號 linking；依 Meta 資格與 app review 結果評估 Instagram、Threads custom OAuth。
- 部署帳號刪除 Edge Function，設定並驗證允許的 origin 和後端 service role secret，再驗證刪除帳號資料收尾。
- 使用兩部裝置走完邀請房、隨機配對、答題、結果、歷史查詢和默契統計，並檢查封鎖、檢舉與帳號刪除權限。
- 在 iOS／Android 實機與 VoiceOver／TalkBack 檢查無障礙操作、分享交接和文字放大，收集玩家回饋。
- 建立人工檢舉審查、玩家聯絡及緊急升級流程；完成前不得宣稱檢舉有人即時處理。
- 依公開服務地區覆核隱私告知與資料保存政策，並做行動裝置及讀屏檢查。
