# Neon 資料層

此目錄的遷移將猜謎資料放在專屬的 `riddle_match` schema，不使用 Supabase、Neon Data API 或 Neon Realtime，也不修改資料庫既有的 `public`、`auth` 或其他 schema。前端經由可信的 HTTPS API 操作；瀏覽器不取得資料庫連線憑證。兩份遷移已套用至指定 Neon 分支的 `neondb`。

## 套用前提

- `migrations/20261126000000_riddle_match.sql` 是全新 schema 的第一份遷移。請先確認目標 project、branch 和 database，再以交易方式執行；若 `riddle_match` schema 已存在，遷移會立即失敗，不會覆寫既有物件或資料。
- 新資料庫依序套用 `20261126000000_riddle_match.sql`、`20261126010000_player_blocks.sql`。已有初版的資料庫只需在交易內套用第二份遷移，無須重新執行第一份；若封鎖資料表已存在，第二份會失敗而不覆寫。每份遷移應只套用一次。
- 遷移連線角色必須能建立 schema、資料表及函式，並執行 RPC。它擁有本 schema，可能繞過 RLS；API 絕不可提供任意 SQL 或直接資料表存取給瀏覽器。
- schema 不對 `PUBLIC` 授權，且資料表啟用 RLS 並預設拒絕未授權角色。此設計不依賴向瀏覽器公開 Neon Data API；不可因資料表已有 RLS 就讓瀏覽器使用擁有者憑證。
- 遷移不啟用 Realtime 或修改整個 Neon project 的 logical replication。配對與房間以短輪詢同步。

## 身分與交易契約

資料庫的 `riddle_match.current_player_id()` 只讀取交易本地設定 `riddle_match.player_id`；**此設定不是認證**。只有可信 API 可持有資料庫憑證、設定該值與執行以下操作：

1. 產生不可預測的隨機 bearer token，將其 SHA-256 小寫十六進位雜湊、對應的 `players.id` 和失效時間寫入 `player_sessions`；原始 token 只回給玩家，不放入資料庫、URL、日誌或版本庫。
2. 每個玩家請求在同一個資料庫連線和交易內查詢未過期 session，例如 `SELECT player_id FROM riddle_match.player_sessions WHERE token_hash = $1 AND expires_at > clock_timestamp()`。查無資料就拒絕，不執行玩家 RPC。
3. API 用查出的 UUID（絕不使用呼叫者提交的 UUID）執行 `SELECT set_config('riddle_match.player_id', $1, true)`；最後一個參數 `true` 使設定只存在於本交易。
4. 只呼叫白名單中的參數化函式，成功後 commit，失敗時 rollback，然後才歸還連線。限制來源網域、請求頻率和輸入；不要把查詢錯誤或 session 雜湊直接回傳給玩家。

API 角色可讀取私有資料，因此任何允許呼叫者自行指定 context、讀表或執行 SQL 的端點都會繞過安全邊界。`api_rate_limits` 僅提供原子限流所需的資料表，請由 API 獨立交易維護限流計數。

## 函式與輪詢

所有函式位於 `riddle_match` schema。玩家操作須在完成上述身分驗證的交易內呼叫；UUID、文字與回合數均以參數傳入。

| 函式 | 結果／用途 |
| --- | --- |
| `join_matchmaking(p_nickname text)` | 回傳 `waiting` 或 `matched` JSON；每次輪詢刷新等待心跳。 |
| `cancel_matchmaking()` | 取消配對，若剛完成配對則結束該房間。 |
| `get_room(p_room_id uuid)` | 回傳房間 JSON（不含謎底、提示或答案別名），並刷新自己的房間心跳。 |
| `get_room_messages(p_room_id uuid, p_round_number integer)` | 回傳該房間該輪訊息 JSON 陣列，依 `created_at, id` 升序排列。 |
| `send_room_message(p_room_id uuid, p_round_number integer, p_body text)` | 回傳建立後的訊息 JSON；sender ID、ID 與時間由伺服器決定。 |
| `submit_riddle(p_room_id uuid, p_riddle text, p_answer text, p_hint text, p_accepted_answers text[], p_round_number integer)` | 出題者提交題目、謎底和提示；伺服器開始五分鐘回合。 |
| `submit_guess(p_room_id uuid, p_guess text, p_round_number integer)` | 猜題者提交答案；資料庫判定結果，逾時後回傳謎底。 |
| `request_room_hint(p_room_id uuid, p_round_number integer)` | 取得本輪提示；重試回傳相同提示，逾時回傳 null。 |
| `end_expired_round(p_room_id uuid, p_round_number integer)` | 以資料庫時間判定逾時並在逾時後揭曉答案。 |
| `start_next_round(p_room_id uuid, p_round_number integer)` | 已結束時交換角色、推進回合和主題。 |
| `leave_room(p_room_id uuid)` | 結束房間，包含已答對或逾時但尚未離開的房間。 |
| `block_opponent(p_room_id uuid)` | 從房間推導對手並封鎖，結束該對玩家目前的房間；重試會回傳相同結果。 |

回合相關函式雖為相容呼叫保留可選 `p_round_number`，API 應一律傳入發起操作時的回合數；過時請求會回報 `round_changed`。訊息每位玩家每 500 毫秒最多一則，每房每輪最多 500 則，分別回報 `message_rate_limited` 和 `message_limit_reached`。送訊息時也會檢查房間參與者、回合、狀態與期限。

建議配對等待與房間畫面各約每 2–3 秒輪詢。等待者超過 30 秒未刷新時，下次配對會忽略並清理；房間建立時給兩位玩家 30 秒寬限，一位玩家看到另一位超過 30 秒沒有房間心跳時會將房間標記 `abandoned`。雙方都停止請求時不會立即執行背景處理。

封鎖由伺服器依房間確認參與者並找出對手，配對會排除任一方向的封鎖；即使對方已先離開也能封鎖。封鎖只對當前匿名玩家身分有效，匿名 session 過期或重建身分後無法保證繼續生效。

## 資料保留

可信 API 可低頻呼叫無參數的 `cleanup_expired_data()`：它批次清理過期等待與 session、超過一天的限流紀錄，並將雙方心跳均逾時的房間標記 `abandoned`；已結束超過七天的房間及關聯訊息、謎底會刪除，無關聯且超過七天的玩家及相關封鎖紀錄也會刪除。清理會避開正在鎖定的資料。現有惰性清理由新請求觸發；若部署並啟用 `function/README.md` 所述的 Neon 排程，沒有新訪客時也會定期執行。額度、故障及單次批次上限仍可能延後清理。

## 本機驗證

```sh
npm ci --prefix neon
npm run test:db --prefix neon
```

預設測試以 PGlite 建立隔離的 PostgreSQL 資料庫，覆蓋未授權存取、跨房隔離、秘密不揭露、逾時和舊回合、重複操作、訊息上限、離線、雙向配對封鎖與保留清理。真正 PostgreSQL 的多連線測試預設跳過；如需執行，先準備專用、可丟棄的 PostgreSQL 測試資料庫（建議與正式環境相同的 PostgreSQL 18），設定連線環境變數後執行：

```sh
RIDDLE_MATCH_TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/TEST_DATABASE' npm run test:postgres --prefix neon
```

PowerShell 可先設定 `$env:RIDDLE_MATCH_TEST_DATABASE_URL`，再執行 `npm run test:postgres --prefix neon`。測試必須能建立 schema；若資料庫已有 `riddle_match` schema，測試會失敗並保留原物件。測試會刪除它自己建立的整個 `riddle_match` schema，請勿指向含正式資料的資料庫，也不要提交連線字串。

多連線測試覆蓋同時配對、等待資料列鎖時跨過回合期限、同一玩家跨欄位重複建房、同時切換回合，以及封鎖與配對競態的兩種先後順序。本機已用 PostgreSQL 18.7 通過；它不模擬正式的 HTTP API、Neon Functions 或兩位訪客，部署前仍需在目標分支驗證。
