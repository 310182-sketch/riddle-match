# Supabase 後端基礎

`migrations/20261126000000_initial_realtime_game.sql` 建立真人配對所需的第一版資料結構與 RPC。這是後端基礎；目前 `site/` 還沒有呼叫這些 API，GitHub Pages 仍會執行單瀏覽器展示流程。

## 部署遷移

1. 建立 Supabase project，並在 Authentication 設定中啟用匿名登入。
2. 開啟 Supabase Dashboard 的 **SQL Editor**，執行 `migrations/20261126000000_initial_realtime_game.sql` 的完整內容。
3. 確認遷移已建立資料表及 RPC，並在 Realtime publication 中發布 `match_rooms` 和 `room_messages`。

遷移假設 Supabase project 已提供 `auth.users`、`auth.uid()`、`authenticated` 角色及 `supabase_realtime` publication。第一次部署前應先在測試用 Supabase project 套用並核對 RLS 與 RPC 權限。

遷移套用後，將 Supabase project URL 和公開用戶端 key 填入 `site/supabase-config.js`。這會啟用 `site/online.js`；設定留白時 `site/boot.js` 會載入單瀏覽器展示版。匿名登入只會識別目前瀏覽器，不代表玩家帳號可復原或跨裝置登入。

## 資料與安全邊界

- `matchmaking_queue` 沒有用戶端資料表權限；配對只透過 `join_matchmaking` 和 `cancel_matchmaking` 修改。配對使用資料庫交易鎖，避免同一位等待者同時被配給兩個房間。
- `match_rooms` 只允許房間參與者讀取。它包含玩家暱稱、角色、主題、謎題和回合狀態，不包含答案。
- `room_secrets` 分開保存謎底、提示與接受的答案別名。用戶端只能直接讀取自己目前擔任出題者的那一輪祕密資料。
- `submit_guess` 在資料庫比較答案，只回傳是否猜中；逾時後 `end_expired_round` 才會回傳謎底。伺服器時間與房間狀態決定回合是否結束。
- `room_messages` 只允許房間參與者讀取；新增訊息時資料庫會驗證發送者、房間、回合和訊息長度。
- Realtime 只發布參與者可讀的房間狀態和訊息。祕密答案表不在 Realtime publication 中。
- 網站前端日後只使用 Supabase project URL 和公開用戶端 key，並依靠 RLS 保護資料；不可將 service-role key 放進 `site/` 或公開 repository。

## RPC 介面

| RPC | 用途 |
| --- | --- |
| `join_matchmaking(p_nickname)` | 以一次性暱稱加入佇列；若找到等待者，建立房間並回傳角色、主題及對手暱稱。 |
| `cancel_matchmaking()` | 取消等待；若配對恰好已完成，則同時結束該房間，避免留下未使用的配對。 |
| `submit_riddle(p_room_id, p_riddle, p_answer, p_hint, p_accepted_answers)` | 出題者提交謎題；啟動五分鐘回合並將答案存入祕密資料表。 |
| `submit_guess(p_room_id, p_guess)` | 由資料庫判定猜測；正確時結束回合，逾時時回傳答案。 |
| `request_room_hint(p_room_id)` | 猜題者每輪索取一次提示。若回合已逾時，回傳 `null` 並結束回合。 |
| `end_expired_round(p_room_id)` | 檢查回合期限並在逾時時揭曉答案。 |
| `start_next_round(p_room_id)` | 結束後交換角色、輪換主題並建立下一輪。 |
| `leave_room(p_room_id)` | 結束尚未完成的房間並清除玩家的等待佇列項目。 |

聊天室訊息透過 `room_messages` 表的受 RLS 保護之 `INSERT` 與 Realtime 訂閱同步。正式接前端前，需依 RPC 回傳型別處理等待、逾時、重複操作及離線狀態。
