# 待決策事項

## Neon CLI 部署授權

- **狀態：** 使用者已同意暫時授權 Neon CLI；資料庫及 Functions 已部署，登入暫時保留至部署驗證完成後撤銷。
- **建議：** 暫時授權官方 Neon CLI，部署並驗證後撤銷本次 CLI 登入；不在聊天或公開 repository 傳送 API key。後續若需要持續自動部署，另建立只限此專案、可撤銷的憑證。
- **原因：** 目前 CLI 的瀏覽器登入會請求帳號層級的專案與組織讀取、建立、修改及刪除範圍；這超過單一專案的必要權限，需由帳號擁有者確認。Dashboard 的個人 API key 表單也未提供專案範圍選擇。
- **不阻塞的工作：** 持續完善程式、測試、文件與 Pages 發布；在 Functions 和雙訪客驗證完成前維持展示模式。

## Neon 部署目標

- **狀態：** 使用者指定以 Neon 專案 `misty-shadow-98835141` 的 `br-soft-morning-beqnhn1z` 分支作為部署目標；先前 Supabase 選型不再是目標方案。資料庫及 Functions 已部署，真人網站尚未啟用。
- **建議：** 保留 GitHub Pages 作靜態前端，移植遊戲狀態與權限保護至 Neon PostgreSQL，採用受保護的後端介面及短輪詢同步；在確認安全和相容前先保留展示模式。若有可逆且經驗證的 Neon 原生即時方案，再評估升級。
- **原因：** Neon 資料庫不能直接當成靜態網站主機；現有 Supabase 的認證、Realtime 與 SDK 不會自動存在於 Neon。不要把資料庫連線密碼或其他伺服器祕密放進前端或公開 repository。
- **目前觀察：** 指定分支為 PostgreSQL 18、Free plan；已確認資料表和回合函式存在、八個原始資料表啟用 RLS、中文主題正確，並以回滾交易驗證配對與封鎖。Neon Realtime 的啟用會影響整個專案，移植初期先不依賴它。

## MVP 玩法預設

- **狀態：** 已採用，日後可依測試回饋調整。
- **進入方式：** 免註冊；配對前使用一次性暱稱，不收集姓名、電話或精確位置。
- **配對與角色：** 以等待佇列配對陌生人，第一輪隨機分配角色；每輪結束交換角色並換主題。等待最多三十秒後提供繼續等待或取消。
- **回合規則：** 每輪五分鐘；猜題者可不限次數提問及猜答案，每輪可取一個提示；時間到揭曉答案並結束該輪。
- **計分：** MVP 不設排名或連勝，先讓玩家專注於對話與猜謎。
- **主題與題目：** 主題由網站提供；出題者依主題自由寫題目，並私下輸入謎底供系統判定。
- **離線處理：** 任一玩家中途離開或斷線時結束本輪，顯示可用結果，讓留下的玩家選擇重新配對或離開。
- **適用範圍：** 第一個真人配對版本的產品預設；後續可依玩家測試結果調整。

## 真人即時配對與聊天室服務（原選型）

- **狀態：** 曾採用並建立第一版資料庫遷移及可選前端流程；使用者現已指定 Neon，相關程式保留作移植參考。Pages 未設定後端時仍是單瀏覽器展示原型。
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
