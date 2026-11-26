# Supabase 後端基礎

本目錄是 Supabase 版真人配對後端的遷移與測試。`site/online.js` 已可呼叫這些 API；未設定 Supabase 時，GitHub Pages 仍會執行單瀏覽器展示流程。

專案後續已指定改用 Neon。以下內容是既有 Supabase 實作的部署與驗證紀錄；不能直接套用到 Neon，因為其中依賴 Supabase Auth 和 Realtime。

## 部署遷移

1. 建立 Supabase project，並在 Authentication 設定中啟用匿名登入。
2. 開啟 Supabase Dashboard 的 **SQL Editor**，依序執行 `migrations/` 中的全部 SQL：先執行 `20261126000000_initial_realtime_game.sql`，再執行 `20261126010000_room_safety.sql`。
3. 確認遷移已建立資料表及 RPC，並在 Realtime publication 中發布 `match_rooms` 和 `room_messages`。

遷移假設 Supabase project 已提供 `auth.users`、`auth.uid()`、`authenticated` 角色及 `supabase_realtime` publication。第一次部署前應先在測試用 Supabase project 套用並核對 RLS 與 RPC 權限。

已套用初始遷移的資料庫只需再套用 `20261126010000_room_safety.sql`。若現有資料包含同一玩家同時參與多個未離開的房間，安全遷移會停止並回報 `duplicate_open_rooms`；應先確認並結束重複房間，再重新套用。安全遷移保留舊 RPC 呼叫方式，新客戶端可提供可選的 `p_round_number`，讓伺服器拒絕延遲抵達的舊回合操作。

## 本機驗證

需要 Node.js 和 npm。在 repository 根目錄執行：

```sh
npm ci --prefix supabase
npm test --prefix supabase
```

測試使用 PGlite 執行兩份遷移，並以模擬的 Auth 角色和使用者驗證 RLS、RPC、答案保護、房間狀態、訊息權限與逾時。它不模擬 Supabase Auth、PostgREST、Realtime 傳送，也不能取代真正 PostgreSQL 的多連線競態測試或兩位訪客實測。

遷移套用後，將 Supabase project URL 和公開用戶端 key 填入 `site/supabase-config.js`。這會啟用 `site/online.js`；設定留白時 `site/boot.js` 會載入單瀏覽器展示版。匿名登入只會識別目前瀏覽器，不代表玩家帳號可復原或跨裝置登入。

## 資料與安全邊界

- `matchmaking_queue` 沒有用戶端資料表權限；配對只透過 `join_matchmaking` 和 `cancel_matchmaking` 修改。配對使用資料庫交易鎖；已結束回合的房間在玩家離開前仍視為開啟，避免同一玩家進入另一個房間後又恢復舊房間。
- `match_rooms` 只允許房間參與者讀取。它包含玩家暱稱、角色、主題、謎題和回合狀態，不包含答案。
- `room_secrets` 分開保存謎底、提示與接受的答案別名。用戶端只能直接讀取自己目前擔任出題者的那一輪祕密資料。
- `submit_guess` 在資料庫比較答案，只回傳是否猜中；逾時後 `end_expired_round` 才會回傳謎底。伺服器時間與房間狀態決定回合是否結束。
- `room_messages` 只允許房間參與者讀取；新增訊息時資料庫會驗證發送者、房間、回合、期限和訊息長度，訊息 ID 和時間由資料庫指定。
- Realtime 只發布參與者可讀的房間狀態和訊息。祕密答案表不在 Realtime publication 中。
- 網站前端日後只使用 Supabase project URL 和公開用戶端 key，並依靠 RLS 保護資料；不可將 service-role key 放進 `site/` 或公開 repository。

## RPC 介面

| RPC | 用途 |
| --- | --- |
| `join_matchmaking(p_nickname)` | 以一次性暱稱加入佇列；若找到等待者，建立房間並回傳角色、主題及對手暱稱。 |
| `cancel_matchmaking()` | 取消等待；若配對恰好已完成，則同時結束該房間，避免留下未使用的配對。 |
| `submit_riddle(p_room_id, p_riddle, p_answer, p_hint, p_accepted_answers)` | 出題者提交謎題；啟動五分鐘回合並將答案存入祕密資料表。 |
| `submit_guess(p_room_id, p_guess)` | 由資料庫判定猜測；正確時結束回合，逾時時回傳答案。 |
| `request_room_hint(p_room_id)` | 猜題者取得本輪唯一的提示；重試會得到相同提示。若回合已逾時，回傳 `null` 並結束回合。 |
| `end_expired_round(p_room_id)` | 檢查回合期限並在逾時時揭曉答案。 |
| `start_next_round(p_room_id)` | 結束後交換角色、輪換主題並建立下一輪。 |
| `leave_room(p_room_id)` | 結束房間（包含已答對或逾時的回合）並通知對方；重複離開不會取消新一輪配對。 |

`submit_riddle`、`submit_guess`、`request_room_hint`、`end_expired_round` 和 `start_next_round` 均接受可選的 `p_round_number`。聊天室訊息透過 `room_messages` 表的受 RLS 保護之 `INSERT` 與 Realtime 訂閱同步；部署後仍需以兩位訪客驗證等待、逾時、重複操作及離線狀態。
