# 待決策事項

## MVP 玩法預設

- **狀態：** 已採用，日後可依測試回饋調整。
- **進入方式：** 免註冊；配對前使用一次性暱稱，不收集姓名、電話或精確位置。
- **配對與角色：** 以等待佇列配對陌生人，第一輪隨機分配角色；每輪結束交換角色並換主題。等待最多三十秒後提供繼續等待或取消。
- **回合規則：** 每輪五分鐘；猜題者可不限次數提問及猜答案，每輪可取一個提示；時間到揭曉答案並結束該輪。
- **計分：** MVP 不設排名或連勝，先讓玩家專注於對話與猜謎。
- **主題與題目：** 主題由網站提供；出題者依主題自由寫題目，並私下輸入謎底供系統判定。
- **離線處理：** 任一玩家中途離開或斷線時結束本輪，顯示可用結果，讓留下的玩家選擇重新配對或離開。
- **適用範圍：** 第一個真人配對版本的產品預設；後續可依玩家測試結果調整。

## 真人即時配對與聊天室服務

- **狀態：** 已採用並建立第一版資料庫遷移及可選前端流程；尚未套用至 Supabase project，也未完成跨訪客驗證。Pages 未設定後端時仍是單瀏覽器展示原型。
- **決定：** 使用 Supabase Auth 匿名登入、Postgres RPC 配對和 Supabase Realtime 同步房間訊息與狀態。
- **原因：** 可保留 GitHub Pages 作為前端，不必先維護自架常駐伺服器；仍須設計防濫用、房間存取權與資料保留規則。
- **適用範圍：** 兩位陌生人即時配對、聊天室與回合狀態同步。
- **安全界線：** 房間公開狀態和祕密答案分開儲存；猜答案、提示、逾時揭曉及回合輪替由經角色檢查的資料庫 RPC 處理。前端只能使用公開用戶端 key，並依賴 RLS 保護資料。

## GitHub repository 發布設定

- **狀態：** 已完成。`310182-sketch/riddle-match` 為公開 repository，`main` 分支由 GitHub Actions 發布至 Pages。
- **建議：** 使用 `310182-sketch/riddle-match`，repository 設為公開，預設分支使用 `main`，並以 GitHub Actions 發布 Pages。
- **原因：** repository slug 易辨識；公開 repository 可直接使用免費 GitHub Pages，且不必另行管理付費方案。
- **公開網址：** `https://310182-sketch.github.io/riddle-match/`。

## GitHub 認證方式

- **狀態：** 已完成。Git Credential Manager 已授權 `310182-sketch`，repository remote 已設定為 `origin`。
- **建議：** 優先使用 GitHub CLI 或 Git Credential Manager 的官方登入流程完成授權，再建立 repository 和推送；不要在聊天中傳送 Personal Access Token。
- **適用範圍：** 需要從本機推送至 GitHub、建立 repository 或檢查 Actions 執行狀態時。
