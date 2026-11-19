# 待決策事項

## 真人即時配對與聊天室服務

- **狀態：** 待決策；目前 Pages 版本是單瀏覽器展示原型。
- **建議：** 進入真人配對實作階段時，先評估 Supabase Realtime，配合 presence 與資料庫規則處理配對佇列、房間訊息和離線狀態。
- **原因：** 可保留 GitHub Pages 作為前端，不必先維護自架常駐伺服器；仍須設計防濫用、房間存取權與資料保留規則。
- **適用範圍：** 兩位陌生人即時配對、聊天室與回合狀態同步。

## GitHub repository 發布設定

- **建議：** 使用 `310182-sketch/riddle-match`，repository 設為公開，預設分支使用 `main`，並以 GitHub Actions 發布 Pages。
- **原因：** repository slug 易辨識；公開 repository 可直接使用免費 GitHub Pages，且不必另行管理付費方案。
- **狀態：** 等待建立 repository 與首次發布。
