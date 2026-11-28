/**
 * 嶸鐿出差打卡系統 - LIFF 前端公開設定檔 (config.js)
 * 注意：此檔案部署於公開的 GitHub Pages，嚴禁存放任何金鑰、Token、Secret 或員工資料。
 * 請在完成 LINE Login LIFF 建立與 GAS 新建部署後，填入以下兩個公開值：
 */
window.APP_CONFIG = {
  // 從 LINE Developers → LINE Login Channel → LIFF 取得的 LIFF ID（例如 '2001234567-AbCdEfGh'）
  LIFF_ID: '2012840460-umJg9L5t',

  // 從 Google Apps Script「部署 → 新增部署作業 → 網頁應用程式」取得的網址
  // 例如 'https://script.google.com/macros/s/AKfycb.../exec'
  GAS_WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbxCsFWmpHDipFDlnbDk_GMv6pyF58CismU09ZDWpgQRhA34ScifVtcLEVCT34yHafJWmA/exec',
};
