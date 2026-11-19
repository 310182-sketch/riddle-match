# 專案經驗

## 靜態前端可以呈現流程，不能提供真人同步

- **經驗：** GitHub Pages 只託管靜態檔案，不會提供配對佇列、多人共享狀態、即時訊息或伺服器答案判定。
- **適用範圍：** 需要多位訪客即時互動的網頁遊戲或協作產品。
- **本專案做法：** 原型使用本機範例資料模擬對方作答，並在畫面和說明中標示示範模式。驗證玩法時可用；不能用來宣稱真人配對已完成。

## 放在瀏覽器的示範資料是公開的

- **經驗：** HTML、JavaScript 和送到瀏覽器的資料都能被訪客檢視。前端範例答案只能供展示，不能用來保護正式答案或裁定競賽結果。
- **適用範圍：** 有隱藏答案、私人房間、計分或共享遊戲狀態的網頁應用程式。
- **本專案做法：** 目前答案只用於示範揭曉。真人配對版本應由服務端保存房間狀態，並在雙方答完後授權揭曉。

## 專案型 GitHub Pages 使用相對資源路徑

- **經驗：** 專案網站通常部署在 repository 子路徑；HTML 引用樣式、腳本和圖示時使用相對路徑，可避免部署後資源回到網域根目錄而找不到。
- **適用範圍：** 發布至 owner.github.io/repository/ 的靜態網站。
- **本專案做法：** 網站集中在 site/，使用同層相對路徑；Pages workflow 上傳 site/ artifact 再發布。

## GitHub Pages 部署權限與設定

- **經驗：** Pages Actions 需要 pages: write 與 id-token: write 權限，repository 的 Pages source 也必須設為 GitHub Actions。
- **適用範圍：** 使用 GitHub Actions 發布 GitHub Pages 網站。
- **本專案做法：** workflow 已存在且可由功能分支觸發，但 `github-pages` environment 的分支保護規則曾拒絕部署。部署失敗時先看實際失敗步驟與 annotation；runner 棄用警告和真正的部署錯誤要分開處理，也不能只憑 workflow 觸發就宣稱網站已發布。

## 靜態前端不可放伺服器祕密

- **經驗：** 公開網站的前端檔案和建置產物都可被下載，不能包含 Personal Access Token、service role key 或其他伺服器祕密。
- **適用範圍：** GitHub Pages 等靜態主機連接第三方服務。
- **本專案做法：** 目前不需要服務金鑰。未來接後端時，只能在前端放可公開的用戶端設定，並由伺服器權限規則保護房間與玩家資料。

## 示範配對要清楚標示，不暗示真人在線

- **經驗：** 以固定範例對象補足單人互動流程時，如果沒有持續揭露示範限制，使用者容易以為正在和真人配對。
- **適用範圍：** 服務尚未接上真人、支付或外部資料時的互動原型。
- **本專案做法：** 配對等待頁、遊戲室和說明視窗都揭露對方及答案由本機資料模擬，並說明資料不會保存。這能驗證畫面流程，不能驗證配對成功率或雙人同步。

## 互動狀態改變時要維持鍵盤與讀屏脈絡

- **經驗：** 單頁流程切換後，鍵盤焦點若留在已隱藏的控制項，下一步操作會不明確；揭曉結果若沒有即時宣告，讀屏使用者也難以察覺狀態已改變。
- **適用範圍：** 單頁應用、逐步表單、問答遊戲和其他動態內容。
- **本專案做法：** 畫面切換時把焦點移到新步驟標題；答題揭曉後把焦點移到下一題按鈕；提供鍵盤焦點樣式、aria-live 宣告和減少動態效果支援。仍需透過實際裝置和輔助科技檢查。

## GitHub 網頁登入不等於 Git push 授權

- **經驗：** 在瀏覽器登入 GitHub 不會自動為本機 Git 設定 push 權限；使用 Git Credential Manager 的官方登入流程可避免把 Personal Access Token 傳入聊天或原始碼。
- **適用範圍：** 使用 Git for Windows 推送 commit、建立 repository 或查詢 Actions 時。
- **本專案做法：** 使用已授權的 Git Credential Manager。開始改動前先檢查目前分支與 remote；遠端產品方向不同時，先用獨立分支保留原有 main。

## 非互動 Git shell 遇到 helper-selector 時改用已安裝的 Credential Manager

- **經驗：** Windows PortableGit 的 helper-selector 在沒有可互動終端時可能停在選擇憑證 helper 的階段，push 沒有輸出但 Git 程序仍在執行。逐一終止自己啟動的停滯程序後，可用單次命令清空既有 helper 清單並指定已安裝的 Git Credential Manager；這仍使用既有安全憑證儲存，不需把 token 放在命令列。
- **適用範圍：** Windows PortableGit、非互動執行環境，且全域 credential.helper 設為 helper-selector 的 Git 操作。
- **本專案做法：** 使用 git -c credential.helper= -c credential.helper='<Git Credential Manager executable path>' push <remote> <branch>，把路徑換成本機安裝位置；若沒有有效登入憑證，仍須由使用者完成官方登入流程。

## 本機預覽也可能載入舊版樣式

- **經驗：** 反覆在同一個 localhost 網址預覽時，嵌入式瀏覽器可能沿用先前快取的同名 CSS。畫面部分樣式正常、不代表新樣式已載入。
- **適用範圍：** 靜態網站原型的本機反覆預覽與視覺除錯。
- **本專案做法：** 先比對伺服器實際回傳的 CSS，再用重新載入或更新樣式連結的版本參數排除快取；必要時從瀏覽器讀取 computed style 驗證字級和狀態。

## 手機視窗模擬能檢查版面與鍵盤流程，不能代替實機讀屏

- **經驗：** 用瀏覽器設定不同 viewport 寬度，可以快速找出水平溢出、過小文字、觸控目標尺寸和動態畫面焦點問題；鍵盤自動操作也能確認每個步驟的焦點去向。這些結果不代表已驗證手機瀏覽器、系統文字放大或螢幕閱讀器行為。
- **適用範圍：** 有響應式版面、單頁流程、互動表單或逐步遊戲的網站。
- **本專案做法：** 以 Chrome 模擬 320、360、390、768、1024、1440px，檢查首頁沒有水平溢出，並在三種手機寬度用鍵盤走完五題。檢查後把主題按鈕調至 12px／手機至少 44px 高，為程式導覽焦點增加明確外框，並替答案按鈕與題目進度補上狀態語意。尚未實機檢查，也未用 VoiceOver 或 TalkBack 驗證。

## 即時事件只傳房間狀態，答案要經過權限檢查

- **經驗：** 如果把答題結果寫進玩家可訂閱的即時資料列，另一位玩家可能在自己作答前讀到答案。事件只需通知房間進度變了；敏感答案應由伺服器函式檢查玩家身分和同房作答數，再決定是否回傳。
- **適用範圍：** 多人遊戲、協作表單和需要同步狀態但不能過早揭露資料的即時應用。
- **本專案做法：** Supabase migration 初稿只發布不含答案的房間狀態；答案表不授予用戶端直接讀取權限，RPC 設計為兩人都答完才回傳雙方選擇。此設計尚未套用到 Supabase，RLS、Realtime publication 和函式權限仍需在實際專案驗證。

## Web Share API 分享圖片需要先準備好檔案

- **經驗：** 行動瀏覽器的 Web Share API 可能要求使用者點擊時仍保有啟用狀態。先產生 PNG 檔案，再在點擊處理器中同步檢查 navigator.canShare({ files }) 並呼叫 navigator.share()，比點擊後才開始繪圖更可靠。使用者取消分享應保持安靜；功能不可用或發生錯誤時再提供下載備援。
- **適用範圍：** 透過手機系統分享選單傳送圖片、檔案或其他內容到社群 App 的網站。
- **本專案做法：** 結果頁顯示時以 Canvas 預先產生 1080×1920 PNG；使用者按分享時交給系統面板，另有明確的下載按鈕。若使用者取消，網站不下載、不代替發布。Instagram 是否出現在分享面板仍須以安裝了 Instagram 的實機驗證。

## GitHub Pages 工作流程不代表分支已獲准部署

- **經驗：** GitHub Actions 可以因 push 正常觸發，仍在部署步驟開始前被環境保護規則拒絕。此時先讀取 Actions check-run annotations，確認分支是否列在部署環境的允許清單，再判斷是否要修改 workflow。
- **適用範圍：** 透過 GitHub Pages environment 或其他有分支保護規則的 GitHub Actions 部署。
- **本專案做法：** codex/commonality-quiz-prototype 的 workflow 已觸發，但 github-pages environment 禁止此分支。推薦在 GitHub environment 允許此功能分支後重跑；不要只根據 workflow 已觸發就將網站標成已發布。

## 手機上的選項要留足點按空間，選取狀態不需雙重描邊

- **經驗：** 多個選項擠在同一列時，窄螢幕會讓文字和點按區域變小；以粗重的內外雙描邊表示選取，也容易使選項在視覺上過度突出。分欄排列、明確的最低高度，以及柔和底色和單一邊框能同時保留辨識度與閱讀空間。
- **適用範圍：** 手機表單、主題選擇、篩選器及多選一控制。
- **本專案做法：** 桌面使用三欄、手機改兩欄並讓隨機選項佔滿一列；按鈕至少 48px 高，選取使用淡綠底色和較淡邊框。改版後以 Chrome headless 檢查首頁、遊戲及結果頁在 320、360、390、768、1024、1440px 的版面，並以鍵盤完成六種寬度的五題流程；均未出現水平溢出或焦點操作阻礙。

## 短期對局資料與長期個人歷史要分開保存

- **經驗：** 若長期歷史直接參照會定期清除的即時房間資料，房間刪除時歷史也會消失；若只保留對局摘要，則可在清除原始答案後繼續提供玩家自己的紀錄和統計。
- **適用範圍：** 需要保存有限期限的對局摘要、活動紀錄或統計，同時定期刪除詳細事件資料的多人服務。
- **本專案做法：** 完局時各為兩位玩家寫入一筆獨立摘要，不以房間外鍵綁住摘要；90 天後清除摘要，刪除帳號時刪除本人歷史並匿名化其他玩家摘要中的顯示名稱。Migration 草稿尚未在 Supabase 套用，需實際驗證 trigger、RLS、清理排程及刪除行為。

## 已套用的資料庫 migration 用新檔案向前擴充

- **經驗：** 已部署的 migration 是環境變更紀錄；直接改寫舊檔不會同步修正已套用資料庫，反而會造成新舊環境的 migration 歷史不一致。
- **適用範圍：** 使用版本化 SQL migration 管理 PostgreSQL、Supabase 或其他資料庫結構的專案。
- **本專案做法：** 保留初版即時配對 migration，另建後續檔案加入邀請房間與歷史摘要。新檔案目前仍是草稿，尚未部署；部署前要在乾淨資料庫按版本順序套用並檢查權限和資料保留行為。

## 沒有 Supabase 專案時可用 PGlite 預檢 SQL migration

- **經驗：** PGlite 可在瀏覽器執行 PostgreSQL，讓 migration 在建立雲端專案前先做套用和 RPC smoke test。以最小 `auth.users`、`auth.uid()` 與角色 stub 模擬 Supabase 依賴，可提早發現 PostgreSQL／PLpgSQL 語法錯誤及核心資料流程問題。
- **適用範圍：** 使用 PostgreSQL、RPC、觸發器和 RLS 的 Supabase 專案，且本機沒有 Docker、PostgreSQL 或 Supabase CLI 時。
- **本專案做法：** 在一次性 PGlite 資料庫依序套用四份 migration，完成雙人答題、歷史／排名、隨機配對、安全 RPC 和帳號刪除收尾預檢；另外確認非成員看不到房間、一般登入者不能直讀答案或檢舉表、封鎖會阻止重配和邀請加入、配對／開房限量、檢舉去重與 180 天清除，以及刪除帳號時關閉房間、匿名化對手歷史並解除檢舉帳號連結。此預檢不等同 Supabase 驗證：Auth claims、Realtime publication、pg_cron、Edge Function secret、CORS 及真實 RLS 執行環境仍須另測。

## 尚未連線的流程要讓示範狀態一眼可見

- **經驗：** 可操作的假代碼或等待畫面容易被當成真實服務；若明確說明無法跨裝置、未向伺服器驗證且不會保存紀錄，仍能展示介面而不誤導玩家。
- **適用範圍：** API、登入或即時服務尚未接通，但需要先檢視前端流程的產品原型。
- **本專案做法：** 邀請房、隨機配對、答題及歷史頁已具備 RPC 流程，但未配置 Supabase URL／key 時，登入與真人操作會停用或顯示明確的本機預覽；歷史頁不展示虛構紀錄。待 Supabase 專案設定完成後，再以真人成功、錯誤、權限拒絕和逾時回應驗證接線。

## 社群 API 可用不等於所有帳號都能拿來登入

- **經驗：** 社群平台的內容 API、OAuth 授權與通用登入服務是不同能力；需核對帳號資格、可取得的穩定識別碼、email、token 期限、app review 和 Auth 服務的 custom provider 要求。
- **適用範圍：** 把 Facebook、Google、X、Instagram、Threads 等第三方身分接入自有帳號系統的網頁或 App。
- **本專案做法：** 先使用 Supabase 內建的 Facebook、Google、X provider；Instagram Login 目前限專業帳號，Threads 要用 custom OAuth 並完成 app review。Instagram／Threads 不保證有 email，因此匿名帳號連結需測試手動 identity linking。每次實作前重新查閱官方文件，因 provider 條件和審核政策可能變動。

## 靜態網站可預先接好 Auth，但必須明確區分未設定狀態

- **經驗：** GitHub Pages 可以載入 Supabase browser client 並支援 PKCE OAuth；若把 project URL／anon key 和 provider 開關放在獨立 client 設定檔，前端整合可先完成，之後再由專案管理者提供公開設定。未設定或 SDK 載入失敗時停用登入按鈕，可避免原型顯示看似成功的登入；provider secrets 仍必須只存後端。
- **適用範圍：** 靜態託管網站需要匿名帳號、OAuth、PKCE callback 或逐步遷移到雲端後端的產品原型。
- **本專案做法：** `site/supabase-config.js` 僅包含公開 URL／anon key 與 provider 設定；匿名登入、OAuth、PKCE session 恢復和 identity linking 使用具 SRI 的 Supabase JS v2.119.2。只有已配置的 provider 才可點擊，缺少服務設定時保留本機示範。mock client 可先檢查前端狀態和 provider ID，但不能取代 Supabase Manual Linking、實際 provider callback 及 GitHub Pages redirect URL 的驗證。

## 私人資料請求要綁定登入帳號和請求代次

- **經驗：** 單頁應用的查詢或刪除請求可能在登出、換帳號或新查詢之後才返回。每次請求應記錄登入者 ID 和遞增的請求代次；登入者改變時先作廢舊代次並清空私人資料，只有身分和代次仍相符的回應才能更新畫面或重設載入狀態。登入狀態回呼中只更新本地狀態，需重新查詢時排到回呼完成後執行。
- **適用範圍：** 有登出／切換帳號能力的單頁應用，以及歷史、個人資料、帳務或其他依使用者隔離的非同步查詢和變更。
- **本專案做法：** 歷史頁在 Auth 使用者變更時清空清單和排名、使進行中的讀寫失效；刪除後只有原帳號的最新請求才能重新載入和顯示完成訊息。Chrome mock 以延遲讀取及延遲刪除確認舊回應不會蓋掉新帳號畫面。這種 mock 驗證前端競態，不代替後端 RLS 或真人 Auth 測試。

## 動態資料頁要用惡意文字和慢回應做 mock 驗證

- **經驗：** 只用正常範例資料會漏掉 HTML 注入與非同步競態。Mock RPC 可回傳看似 HTML 的玩家名稱和題目文字，並控制請求完成順序，以確認資料只以文字節點顯示、舊回應不會跨畫面或帳號寫入狀態。
- **適用範圍：** 把使用者內容、資料庫欄位或第三方 API 資料插入動態 UI 的前端功能，尤其包含個人資料或可分頁清單者。
- **本專案做法：** Chrome mock 覆蓋歷史載入、空狀態、錯誤重試、游標分頁、刪除後刷新和帳號切換；對名稱、題目和共同答案注入 `<img>`／`<svg>` 樣式字串，確認頁面沒有建立對應 DOM 節點或觸發事件。Live Supabase 權限與資料內容仍須另驗。

## RPC 前端串接要保留示範與真人狀態的清楚界線

- **經驗：** 靜態原型即使已寫好 RPC 呼叫，沒有專案設定或玩家 session 時也不能假裝服務成功。把 provider client 設定檢查、RPC 回傳狀態分支、登入要求和本機示範分開處理，能逐段交付 UI 而不混淆真實與預覽資料。
- **適用範圍：** GitHub Pages 等靜態前端逐步接入 Supabase 或其他需要登入及伺服器狀態的服務。
- **本專案做法：** 邀請房在 Auth 與公開 client 設定可用時呼叫 `create_invite_room`、`join_invite_room`、`get_invite_room_status` 和 `leave_room`；建立／加入／錯誤／逾期由 RPC 結果決定。無 Supabase 設定時仍顯示明確示範預覽。Chrome mock 覆蓋建立、代碼正規化、房主等待、對方加入、逾期及離開；後續答題與結果透過權限檢查 RPC 同步，Realtime 只作房間變更通知並保留輪詢備援。真人 Supabase 與跨裝置流程尚待驗證。

## Realtime 事件用來觸發重新查詢，答案揭曉仍由 RPC 授權

- **經驗：** Realtime 適合通知客戶端房間可能有新狀態，但不要直接訂閱包含玩家答案的資料。事件到達或輪詢計時時，都重新呼叫會檢查玩家身分的狀態 RPC；畫面只在 RPC 明確回傳雙方答案可揭曉時顯示選擇。操作按鈕也需等待 RPC 結果，避免本機畫面先於伺服器狀態前進。
- **適用範圍：** 有答案保密要求的多人遊戲、協作表單及其他即時互動。
- **本專案做法：** `game_rooms` 更新事件只觸發 `get_room_state`，前端另以定時輪詢作備援；送答、確認前進和讀取結果分別呼叫 `submit_answer`、`continue_room`、`get_room_results`。Chrome mock 已驗證對方未作答時不揭曉、雙方確認後才前進、最後只顯示 RPC 回傳的共同選擇。Supabase Realtime 授權、離線和跨裝置仍待真人環境測試。

## 隨機配對要以服務端票券狀態處理逾時與取消競態

- **經驗：** 配對畫面不能只依靠前端倒數判定逾時；加入佇列後應保存服務端 ticket ID，輪詢權限檢查後的狀態，並在逾時或離開時取消票券。取消與配對成功同時發生時，應以伺服器最後狀態為準，避免成功配對後仍留在等待頁。
- **適用範圍：** 隨機配對、工作佇列及其他有期限且可取消的非同步請求。
- **本專案做法：** 前端使用 `queue_for_match` 取得票券，透過 `get_match_status` 輪詢並用 `cancel_matchmaking` 取消；服務端回報配對成功時轉入真人房間，逾時頁面可重新排隊。Chrome mock 已驗證配對成功、30 秒逾時重試與取消；Supabase 競態及實際逾時仍待線上環境驗證。

## 檢舉與封鎖要由伺服器確認房間身分和配對規則

- **經驗：** 檢舉和封鎖不能只在前端隱藏玩家或接受用戶端指定的被檢舉者 ID。後端應從登入者和同房成員關係推導對象；封鎖必須同時排除隨機配對並阻擋邀請房加入；檢舉表不應授予一般玩家直接讀取權。檢舉與處分也要分開，避免惡意檢舉自動造成封號。
- **適用範圍：** 有匿名帳號或隨機配對的雙人遊戲、社群配對、媒合平台及其他讓使用者彼此互動的產品。
- **本專案做法：** `block_room_opponent` 和 `submit_player_report` 只接受房間 ID，再由伺服器驗證登入者是房間成員並找出對方；封鎖清單只由本人專屬 RPC 操作，雙向封鎖會跳過配對，邀請加入另以資料庫觸發器檢查。檢舉一房一筆、說明最多 500 字、案件最多保留 180 天；一般登入者不能直接讀取檢舉表，刪除帳號會解除案件與帳號 ID 的連結。PGlite 已預檢主要權限與規則；Supabase RLS、pg_cron 和實際審查營運仍須另驗。
- **操作限制：** 服務端可用帳號限量降低重複開房／排隊，但匿名帳號可重新建立，不能取代 IP／裝置層級風控。若尚無值班審查人員和聯絡方式，介面要明說檢舉不會即時有人處理，且不能把它當成緊急支援管道。

## 靜態前端的帳號刪除要經過驗證過的後端函式

- **經驗：** 靜態前端不能安全持有 Supabase service role key，也不能直接刪除 `auth.users`。刪除函式應驗證呼叫者的 JWT，從已驗證 session 取得帳號 ID，不接受瀏覽器指定任意目標 ID；再由後端 service role 執行管理刪除。可用精確 origin allow list 限制瀏覽器來源，並讓前端在函式部署和來源設定完成前保持停用。
- **適用範圍：** GitHub Pages 等靜態網站需要提供 Supabase 使用者自助刪除帳號的產品。
- **本專案做法：** `delete-account` Edge Function 用使用者 session 呼叫 Auth `getUser()`，再以後端 service role 刪除剛驗證的 `user.id`；前端只呼叫 Edge Function，公開設定只存 `accountDeletionEnabled`。帳號刪除前的資料庫 trigger 先結束進行中房間並取消等待票券，避免單純 cascade 刪除成員後留下仍顯示 playing 的房間。PGlite 可檢查資料庫 trigger、外鍵和匿名化，但 Supabase Auth Admin 權限、Edge secret、JWT 驗證和 CORS origin 必須在真實專案驗證。

## 響應式窄版需同時檢查捲軸與控制項名稱

- **經驗：** 窄螢幕常隱藏按鈕的文字，只留下箭頭或圖示；如果按鈕沒有 `aria-label` 或其他等效名稱，讀屏看到的可能只剩符號。桌面瀏覽器模擬手機寬度時，傳統垂直捲軸也會縮小頁面可用寬度；`min-width` 若等於模擬視窗寬度，可能額外觸發水平捲動。檢查響應式畫面時，應核對控制項名稱及根節點實際 `clientWidth`／`scrollWidth`。
- **適用範圍：** 導覽按鈕、圖示按鈕、行動版工具列，以及任何會依斷點改變可見標籤或容器最小寬度的網頁介面。
- **本專案做法：** 320px 歷史頁預覽中，「回首頁」文字被隱藏後，瀏覽器無障礙樹只提供「←」作為按鈕名稱；`body` 的 320px 最小寬度又比含垂直捲軸的 305px 可用寬度大。已為邀請房與歷史頁返回按鈕補上 `aria-label="回到首頁"`，並移除 `body` 硬性最小寬度；修正後以 320／360px 預覽重驗。真實 iOS／Android 與讀屏驗證仍待執行。

## Edge Function 遠端依賴要固定版本

- **經驗：** 使用 Deno URL import 的 Edge Function 若只固定套件主版本，重複部署時可能載入不同的 minor／patch 實作。以精確套件版本固定行為，並和瀏覽器端共用相同版本，可減少 API 差異與除錯變因；版本存在及 URL 可回應只能確認套件可取得，仍需 Deno 編譯和目標平台驗證。
- **適用範圍：** Deno Edge Functions、透過 esm.sh 載入 npm 套件的服務，以及使用 CDN 的靜態前端。
- **本專案做法：** `delete-account` 使用 `https://esm.sh/@supabase/supabase-js@2.119.2`，與瀏覽器載入的 Supabase JS 版本一致。確認 npm registry 版本存在且 esm.sh 回應 HTTP 200；將官方 Windows Deno 發布檔下載到暫存資料夾並核對 SHA-256 後，以 Deno 2.9.8 執行 `deno check`、`deno lint` 及 `deno fmt --check` 成功（初次格式檢查後套用 `deno fmt`）。PGlite 帳號刪除檢查亦通過；Edge Function 尚未部署，Supabase Auth Admin、Edge secrets、JWT gateway 與 CORS 仍待線上驗證。

## 將 Edge Function 請求處理器與伺服器啟動分開

- **經驗：** 將 HTTP request handler 匯出，並只在 `import.meta.main` 時啟動 `Deno.serve`，可以直接對 handler 執行本機測試，而不需要啟動監聽服務或使用真實第三方憑證。測試環境變數應在動態匯入 handler 前設定，避免模組快取讀到錯誤設定。
- **適用範圍：** Supabase Edge Functions、Deno serverless handlers，以及需要驗證 CORS、HTTP method 和未登入錯誤分支的無伺服器 API。
- **本專案做法：** `delete-account/index.ts` 匯出 `handleRequest`，測試匯入時不啟動 Edge Function server；Deno 測試在 loopback 啟動 mock Auth API，使用暫存假設定覆蓋允許／拒絕的 preflight、origin 拒絕、非 POST、缺少／無效 Bearer token，以及成功時只刪除 token 對應的 ID 並使用後端管理 key。7 個子測試全通過。這不驗證 Supabase gateway JWT、正式 Auth Admin 權限、CORS 部署、Edge secrets 或資料庫 trigger，仍需在 Supabase 環境驗證。
