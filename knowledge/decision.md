# 決策紀錄

最後整理：2026-11-20

## 本分支的產品方向

- **狀態：** 本分支採用；與遠端 `main` 的產品方向不同。
- **現況：** 遠端 `main` 是陌生人自由提問的猜謎遊戲；目前工作區依二選一共同點遊戲方向製作原型。
- **決定：** 依照 `knowledge/plan.md` 製作二選一共同點遊戲，不把自由聊天或猜謎流程帶入本分支。
- **適用範圍：** 目前原型及後續路線；若使用者改回猜謎產品，需先調整計畫和原型方向。

## 二選一原型

- **狀態：** 已實作互動原型。
- **決定：** 每局配對兩位玩家，主題從旅行、音樂、日常、飲食中擇一，也可隨機選擇；原型一局五題，每題兩個選項，雙方都答完才揭曉。結果頁顯示相同答案題數和共同選擇。
- **示範模式：** 原型由本機範例資料提供示範對象及答案，畫面需清楚標示模擬資料；尚未實作真人配對、跨裝置同步或保存遊戲紀錄。
- **適用範圍：** 瀏覽器互動原型，不代表正式版題數、配對期限、紀錄保存或登入規格已全部定案。

## 房間與配對

- **狀態：** MVP 預設已採用；邀請房間 RPC 已寫入 migration 草稿，尚未部署或接上前端。
- **決定：** 玩家可建立雙人邀請房間，分享 12 位隨機代碼讓另一位玩家加入；房間 10 分鐘沒有第二位玩家加入就失效。房主在遊戲開始前離開時關閉房間。
- **決定：** 玩家每次只能參加一個進行中的房間。隨機配對等候上限為 30 秒；逾時可以重新排隊。房間開始後閒置 10 分鐘就失效。
- **決定：** 玩家指定不同主題時不互相配對；任一方選隨機即可配對並沿用另一方主題；雙方都選隨機時由系統抽一個主題。
- **適用範圍：** 二人 MVP；房間密碼、多玩家房間及自訂逾時不納入首版。

## 真人配對與後端

- **狀態：** Supabase 為目前真人 MVP 的實作預設；兩份 migration 已在 PGlite 本機預檢環境套用，並測過邀請對局、雙人揭曉／推進、歷史排名、隨機配對及基本 RLS 邊界；尚未部署或在 Supabase 驗證。
- **決定：** 以 Supabase Anonymous Auth 驗證玩家、PostgreSQL RPC 執行建立房間／加入房間／原子配對與答案提交，Realtime 傳遞房間狀態。
- **安全規則：** 答案留在資料庫；只有同一房間兩位玩家都完成作答後才回傳雙方答案。以 RLS 限制玩家資料存取，不開放用戶端直讀答案表；service role key 不放在前端。
- **同步規則：** 揭曉後兩位玩家都按「下一題」才推進；先按的人等待對方。正式閒置時間、離線及重新連線行為仍需實測及定案。
- **資料保存：** 房間、暱稱及原始答案於遊戲結束或離開後保留 24 小時；每位玩家另有自己的歷史摘要，保存 90 天，玩家可提前刪除。
- **未完成條件：** 建立 Supabase 環境、套用 migration；在 Supabase 實測 RLS／Realtime／RPC 權限、清理排程和匿名 Auth；接上前端並用不同裝置驗證整局流程。PGlite 預檢不涵蓋 Supabase Auth、Realtime publication、pg_cron 或 Supabase 專案設定。

## 匿名與社群登入

- **狀態：** 已確認納入產品範圍，尚未實作或設定 OAuth。
- **決定：** 提供匿名登入，以及 Instagram、Facebook、Google、X、Threads 社群登入。匿名帳號連結社群身分時需保留玩家 ID 與可延續的歷史紀錄。
- **設定界線：** provider secret 僅存在後端／Supabase Auth 設定；GitHub Pages 前端只使用公開的 project URL 和 anon key。
- **待驗證：** 建立各平台 app、callback URL、公開應用資格和測試帳號；實測 provider 組態、重複帳號連結、登出後重新登入及匿名帳號轉正式身分。平台支援限制見下方技術審查。

## 社群登入技術審查

- **狀態：** 已查閱 Supabase、Meta 和 X 官方文件（2026-11-20）；尚未建立 provider app、設定 callback 或執行登入測試。
- **Facebook／Google：** Supabase Auth 內建 provider，可直接採用官方設定流程。
- **X：** Supabase 現行建議使用內建的 X／Twitter OAuth 2.0 provider；官方文件指出舊 Twitter OAuth 1.0a provider 將在未來版本淘汰。
- **Instagram：** 不在 Supabase 內建清單。Meta 的 Instagram Login 可用 OAuth 2.0 接入 Supabase custom OAuth provider，但官方產品目前面向 Instagram 專業帳號（商家與創作者），不能當作所有個人帳號通用登入。推薦只把它提供給符合 Meta 條件的專業帳號，並保留匿名登入作為一般玩家入口。
- **Threads：** 不在 Supabase 內建清單。Meta Threads API 提供 OAuth 2.0 使用者授權及 `threads_basic` 個人檔案權限，可評估以 Supabase custom OAuth provider 接入；向沒有應用程式角色的一般使用者開放前需完成 Meta app review。
- **Supabase 限額：** Free plan 可新增最多 3 個 custom provider；Instagram 與 Threads 共用其中 2 個名額。
- **帳號連結：** Instagram／Threads 不保證提供可供帳號自動合併的 email。匿名帳號升級時應使用已登入狀態下的手動 identity linking；Supabase 將此功能標示為 beta，custom provider 連結尚須實測。不能只依賴相同 email 自動連結。
- **推薦實作順序：** 先完成 Google、Facebook、X 內建 provider，再驗證 Threads custom OAuth；Instagram custom OAuth 僅依專業帳號限制提供。所有流程均須使用 Supabase callback，client secret 保留在 Supabase Auth 設定。
- **官方依據：** [Supabase social sign-in](https://supabase.com/docs/guides/auth/social-login)、[Supabase custom OAuth/OIDC providers](https://supabase.com/docs/guides/auth/custom-oauth-providers)、[Supabase identity linking](https://supabase.com/docs/guides/auth/identity-linking)、[Meta Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)、[Meta Threads API](https://developers.facebook.com/docs/threads/get-started/)、[Supabase X OAuth 2.0](https://supabase.com/docs/guides/auth/social-login/auth-twitter)。

## Supabase Auth 前端接線

- **狀態：** 已實作可選的瀏覽器端 Auth client 和登入介面，並用 mock client 檢查匿名登入、Facebook identity linking 和 X OAuth provider ID；尚未設定 Supabase 專案或驗證真人 provider flow。
- **決定：** 靜態網站的 `site/supabase-config.js` 只存 project URL、anon／publishable key 和已啟用 provider 清單。Facebook、Google、X 使用內建 provider；X 對應 provider ID `twitter`。Instagram、Threads 只接受 Supabase `custom:` provider 識別碼。
- **登入行為：** 玩家可匿名登入；已登入玩家按社群 provider 時使用 Supabase identity linking，保留現有匿名帳號。以 PKCE 保存和恢復 session，不在畫面顯示 email 或 provider token。
- **安全界線：** URL 和 anon／publishable key 屬公開 client 設定；provider client secret 和 service role key 只存在 Supabase Auth／後端。未提供設定或 SDK 時，登入按鈕停用且本機示範繼續運作。登入成功目前仍不代表真人配對或歷史功能已連線。
- **尚待外部設定：** Supabase 專案 URL 和公開用戶端 key、啟用 Anonymous Auth 與 Manual Linking、provider app／callback、允許 redirect URL，以及 Instagram／Threads custom OAuth 設定。這些資料目前不在工作區，尚不能執行 live login。
- **推薦：** 先以開發用 Supabase 專案完成 Anonymous Auth 與 Google／Facebook／X callback 和 linking 實測，再設定正式 GitHub Pages redirect；Meta custom provider 等 app review 和帳號資格確認後再開放。

## 歷史紀錄與共同點統計

- **狀態：** 產品規格已採用；歷史資料表、完局摘要 trigger 與查詢 RPC 已寫入 migration 草稿。歷史頁前端已接上這些 RPC 契約，並以 mock 驗證清單、分頁、排名、刪除和帳號切換；Supabase migration 尚未部署，後端權限和真人資料仍未驗證。
- **決定：** 每位玩家只能查詢自己的已完成對局摘要，包含主題、完成時間、對手暱稱、共同題數和共同答案。紀錄保存 90 天，可由玩家逐筆刪除；刪除帳號時移除該帳號的歷史。
- **決定：** 默契排名以最近 90 天的共同答案比例計算；至少和同一玩家完成 3 局才列入排名，同分依對局數較多者優先。顯示共同答案總數和對局數；頁面只對本人可見，不建立公開排行榜。
- **資料政策：** 即時遊戲房間、暱稱和原始答案於結束後 24 小時清除；每位玩家各自的 90 天歷史摘要獨立保留。帳號刪除時匿名化其他玩家歷史中對該帳號的顯示名稱。
- **原因：** 分開保留短期即時資料和限期歷史摘要，可同時支援歷史查詢、配對統計與資料最小化。

## Instagram 限時動態分享

- **狀態：** 已在本機原型實作，尚未在 iOS／Android 實機驗證。
- **決定：** 結果頁產生 9:16 PNG 分享卡；玩家主動按下分享後呼叫裝置分享面板，由玩家選擇 Instagram 並自行確認發布。若瀏覽器不支援分享檔案或沒有 Instagram 分享目標，提供 PNG 下載。
- **實作：** 原型已用 Canvas 產生 1080×1920 PNG，提供分享面板與下載按鈕。使用者取消系統分享時不自動下載；分享失敗或瀏覽器不支援時提供 PNG 備援。
- **內容界線：** 分享卡只包含主題、共同答案和品牌；不放匿名帳號 ID、登入資料或聯絡資訊。示範模式需標示答案是模擬資料。
- **待驗證：** 在 iOS／Android 裝置上確認分享面板與 Instagram 限時動態的交接及下載備援。

## 發布

- **現況：** 功能分支的部署 workflow 已觸發，但被 GitHub Pages 的 github-pages environment protection rules 拒絕；本分支尚未發布。
- **原因：** Actions 註解指出 codex/commonality-quiz-prototype 不在允許部署的分支規則內，失敗發生於工作步驟開始前。
- **決定：** 保留遠端 `main` 的猜謎版本，先發布本分支的二選一原型；真人後端及權限驗證完成後再發布連線版本。
- **推薦：** 在 GitHub repository 的 github-pages environment 允許 codex/commonality-quiz-prototype 部署，再重跑 workflow；只加入此分支即可保留現有環境保護。此設定變更需先取得使用者確認。
