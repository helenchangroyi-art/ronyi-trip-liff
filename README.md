# 嶸鐿出差打卡系統（LIFF 前端）

本 repo 為「嶸鐿出差打卡」系統的手機版 LIFF 靜態網頁，部署於 GitHub Pages（Public）。

- **安全設計**：本 repo 不含任何金鑰、Token、Secret 或員工資料；每次操作皆以 `liff.getIDToken()` 送至 GAS 後端向 LINE 官方驗證身分。

## 部署步驟

1. **開啟 GitHub Pages**：
   - 到本 repo 的 **Settings → Pages**
   - Source 選 **Deploy from a branch** → Branch 選 **`main`**、資料夾選 **`/ (root)`** → Save
   - 發布後的網址為：`https://helenchangroyi-art.github.io/ronyi-trip-liff/`
2. **填入設定**：
   - 編輯 [`config.js`](config.js)，填入 `LIFF_ID` 與 GAS 新建部署後的 `GAS_WEB_APP_URL`，commit & push 即可上線。
3. **圖文選單頁面參數**：
   - 打卡：`https://liff.line.me/<LIFF_ID>?page=checkin`
   - 本月草稿：`https://liff.line.me/<LIFF_ID>?page=draft`
   - 我的紀錄：`https://liff.line.me/<LIFF_ID>?page=records`
