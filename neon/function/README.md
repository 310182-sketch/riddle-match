# Neon Functions API

GitHub Pages 提供靜態網站；此函式提供匿名遊戲 API，連到指定 Neon branch 的私有 `riddle_match` schema。官方文件明確說明 [Neon Functions 不支援託管網站](https://neon.com/docs/compute/functions/overview#how-functions-fit-with-your-app)，所以前端繼續使用 Pages，函式只處理 API。

## 本機檢查

```sh
cd neon/function
npm ci
npm test
```

測試包含模擬 API、排程清理，以及本機 PGlite 載入實際 migration 的雙玩家配對、聊天、答案保護、越權與換輪測試，不連線至 Neon。資料庫測試另見 `../README.md`。

## 在指定 branch 部署

以下是部署指引；執行前先核對 project、branch 與資料庫。Migration 在 `../migrations/`；先依 `../README.md` 依序將尚未套用的 migration 套用到正確 branch，並以獨立測試玩家驗證。初版要求 `riddle_match` schema 尚未存在；切勿覆蓋既有 schema。

Neon Functions 支援 AWS US East 2（Ohio），由 Neon 在執行時注入該 branch 的 `DATABASE_URL_UNPOOLED`。驗證 session、設定交易身分與遊戲操作要在同一個多次往返交易完成，依 [Neon 文件](https://neon.com/docs/compute/functions/environment-variables) 使用直連而不回退到 pooled URL；每個執行個體最多保留兩條連線，仍應監控擴容時的總連線數。資料庫密碼、API key 與 service key 都不可放進 `site/`、前端設定或版本庫。建議另使用僅有本服務所需權限的資料庫角色，避免以廣泛權限存取同 branch 其他資料。

在 repository 根目錄，完成 Neon CLI 的瀏覽器登入後，可指定 project 及 branch 部署單一函式：

```sh
neon functions deploy riddlematch --src neon/function/index.mjs \
  --project-id <project-id> --branch <branch-id-or-name> \
  --env ALLOWED_ORIGINS=https://310182-sketch.github.io
neon functions get riddlematch --project-id <project-id> --branch <branch-id-or-name> --output json
```

部署使用的函式 slug 固定為 `riddlematch`。確認 deployment 的狀態為 `completed`，再取其公開 `invocation_url`，填入 `site/neon-config.js` 的 `functionUrl`；此 URL 不是資料庫連線字串。重新部署 Pages 後，以兩個獨立瀏覽器驗證配對、謎底保護、聊天、換輪與離線。

預設 CORS 僅接受 `https://310182-sketch.github.io`。如需本機預覽，需明確將該預覽來源加入函式環境，例如 `ALLOWED_ORIGINS=https://310182-sketch.github.io,http://localhost:4173`；部署環境變數會覆寫預設清單。這是瀏覽器來源限制，不是身分驗證：攻擊者可以偽造 Origin，房間存取仍依賴 session 與資料庫角色檢查。

請參考 [Functions 部署文件](https://neon.com/docs/compute/functions/deploy)、[環境變數文件](https://neon.com/docs/compute/functions/environment-variables) 與 [CLI 登入文件](https://neon.com/docs/cli/login)。CLI 也能使用 `NEON_API_KEY`，但不要把金鑰寫進命令記錄、程式或聊天。

## HTTP 契約與限制

- `POST /session` 接收 `{}`，回傳 `{token,user_id,expires_at}`。token 為隨機 256 位元，只有 SHA-256 雜湊儲存在資料庫，固定 24 小時到期；`GET /session` 以 bearer token 檢查是否仍有效。
- `POST /rpc/<name>` 接收既有的 `p_*` 參數；成功時回 `{data}`，失敗時回 `{error:{code,message}}`。可呼叫操作固定列在 `api.mjs`，每個交易先驗證 session，再以 transaction-local context 執行資料庫函式。
- `POST /rpc/block_opponent` 僅接受 `{p_room_id}`，由資料庫根據登入者與房間確認要封鎖的對手；成功回 `{data:{state:"blocked"}}`，非房間成員回 403，重試相同操作不會重複建立紀錄。封鎖會結束房間，並阻止雙方再次配對；保護範圍限於目前的匿名身分，不會延續到日後建立的新 session。
- 只接受明確允許的 Origin、JSON 與最多 8 KiB 的 request body；讀取總時間上限 5 秒，逾時回 408。函式不傳回 SQL 錯誤、資料庫位址或憑證。
- 目前限制每位玩家 150 次／分鐘、通過每人限額的有效 session 請求全站 3000 次／分鐘、全站 session 建立 30 次／分鐘；聊天室另限制同一玩家 500ms 一則、每輪最多 500 則。短輪詢應依 `Retry-After` 退避。
- 全站限額能限制資料庫負載，但可能被惡意耗盡而讓其他人暫時無法使用；不應將可偽造的轉送標頭當成客戶端 IP。正式公開服務前仍需可信的邊緣防濫用和監控。
- 房間心跳與現有清理由請求惰性觸發。新 session 建立時低機率在背景清理過期資料；也可依下方方式部署獨立排程清理。保留方式詳見 `../README.md`。

## 定期資料清理

`retention.mjs` 是獨立的 Neon Function，保留既有 session 建立時的惰性清理作為補充。它只接受 Neon schedule trigger 送到 `/` 的 `POST`，使用固定 SQL 呼叫 `riddle_match.cleanup_expired_data()`；每次最多執行 10 個有限批次，資料仍依現有逾期條件刪除。重複或延遲觸發可安全重試，數量過大時剩餘資料留待下次清理。

此認證依賴 [Neon 邊緣會移除外部送入的 `X-Neon-*` 標頭](https://neon.com/docs/compute/functions/triggers/overview#confirming-a-request-came-from-neon)：handler 驗證 trigger header、body 中一致的 invocation ID、排程類型及名稱。不可把此 handler 直接暴露在沒有相同驗證保證的其他主機或代理後面；本機測試以模擬標頭驗證程式邏輯，不能證明 Neon 的邊緣行為。

在 repository 根目錄，先確認目標 branch 已套用所有 migration、具備 Functions 與 trigger 管理權限，並檢查 branch 沒有同名 trigger，再執行：

```sh
neon functions deploy rmcleanup --src neon/function/retention.mjs \
  --project-id <project-id> --branch <branch-id-or-name>
neon triggers list --project-id <project-id> --branch <branch-id-or-name>
neon triggers create --function-slug rmcleanup --name riddle-match-retention \
  --cron '0 18 * * *' --function-path / --project-id <project-id> --branch <branch-id-or-name>
neon logs query --source function --service-name neon-function/rmcleanup \
  --since 24h --project-id <project-id> --branch <branch-id-or-name>
```

此排程每天 UTC 18:00 執行（台北時間次日 02:00）。建立同名 trigger 會被 Neon 拒絕；不要重複建立。子 branch 繼承的 trigger 預設停用。成功與失敗分別記錄 `retention_cleanup_completed`、`retention_cleanup_failed` 及 invocation ID；資料庫失敗會回 503 並要求稍後重試，Neon 最多在事件建立後 72 小時內重試。異常 trigger 請求記錄 `retention_trigger_invalid`。日誌不含 SQL 錯誤內容、連線字串或玩家資料；應檢查日誌與缺少的成功紀錄，平台日誌保存時間依方案而定，免費方案的監控資料為一天，不代表自動告警。

官方文件顯示此功能可用於免費方案，但每次執行與喚醒資料庫都消耗該方案的 Functions 和資料庫額度；額度耗盡、部署失敗或長時間累積超過批次上限時，無法保證精確在七天整刪除。部署後需確認 trigger 已啟用並觀察一次成功執行；此 repository 尚未替使用者啟用排程。參考 [Neon schedule trigger](https://neon.com/docs/compute/functions/triggers/schedule)、[失敗重試](https://neon.com/docs/compute/functions/triggers/overview#delivery-and-retries) 和 [方案額度](https://neon.com/docs/introduction/plans)。

Functions 具有執行個體淘汰與帳戶並行限制；前端必須在暫時離線或 429 後退避並重新同步。上述設計與本機測試尚不代表已對真實 Neon 分支完成部署或權限驗證。
