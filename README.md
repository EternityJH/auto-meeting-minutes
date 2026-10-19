# Auto Meeting Minutes (自動會議記錄助手) 🎥📝

這是一款專為 Google Meet 設計的 Chrome 擴充功能，能夠在您開會時**自動擷取 CC 字幕**、並在會議結束後自動透過 **Google Gemini API** 進行語意修正與重點整理，最後可透過 **Google Apps Script Webhook** 自動發送精美的 HTML 會議紀錄郵件給多個指定收件人。

---

## 🌟 核心特色
1. **自動開啟字幕 (CC)**：進入 Google Meet 時可依設定自動啟動字幕擷取。
2. **即時字幕記錄**：自動擷取發言時間、發言人與內容。
3. **AI 智慧整理與語意優化**：串接 Google Gemini API（支援最新的 `gemini-3.5-flash`、`gemini-3.1-pro` 旗艦模型），一鍵將辨識錯誤、同音異字、贅字過濾，並條列整理出「會議主旨」、「重點摘要」與「待辦事項」。
4. **雙欄對照 HTML 報告**：自動匯出包含「原始對話」與「AI 優化對話」左右對比的 HTML 會議紀錄網頁，支援一鍵複製純文字。
5. **電子郵件與 Webhook 自動發送**：整合 Google Apps Script，會議結束時自動將排版寬敞、精美的 HTML 會議記錄寄給指定的收件人名單。
6. **極佳防呆 UX**：擴充功能面板支援「背景自動處理」狀態追蹤（呼吸燈提示），避免重複觸發。

---

## 📥 如何分享與安裝 (安裝步驟)

目前此擴充功能尚未上架至 Chrome 線上應用程式商店。您可以直接將此 GitHub 專案分享給朋友，並請他們按照以下步驟安裝：

### 步驟 1：下載專案代碼
1. 在本 GitHub 頁面右上角，點擊 **「Code」** -> **「Download ZIP」**。
2. 下載後解壓縮至您的電腦中（例如解壓至桌面或文件夾，請記住此資料夾路徑，**內含 `manifest.json` 檔案**）。

### 步驟 2：載入擴充功能到 Chrome
1. 開啟 Chrome 瀏覽器，在網址列輸入 `chrome://extensions/` 並按 Enter（或點選 Chrome 右上角三個點 -> 延伸功能 -> 管理延伸功能）。
2. 在延伸功能頁面右上角，開啟 **「開發者模式 (Developer mode)」** 切換開關。
3. 點選左上角出現的 **「載入未封裝項目 (Load unpacked)」** 按鈕。
4. 選擇您剛剛解壓縮出來的**專案資料夾**（請選取包含 `manifest.json` 的那一層資料夾）。
5. 載入成功！您會在清單中看到 **Auto Meeting Minutes**，點選 Chrome 右上角的「拼圖圖示 🧩」將它釘選到工具列即可開始使用！

---

## 🛠️ 初始化設定指南

載入擴充功能後，點擊圖示開啟面板，切換到 **「設定 (Settings)」** 分頁：

1. **取得免費的 Gemini API Key**：
   - 點擊「Gemini API Key」旁邊的 **「如何取得 API Key？」** 連結，按照說明前往 Google AI Studio 免費建立。
   - 貼回設定中並點擊「儲存設定」。
2. **架設自動寄信 Webhook (選填)**：
   - 點擊「Webhook URL」旁邊的 **「如何架設自動寄信 Webhook？」** 連結。
   - 複製網頁中的 Google Apps Script 程式碼，貼到您的 Google Apps Script 中並部署為「網頁應用程式」（權限請務必設為「所有人 (Anyone)」）。
   - 複製產生的 Web URL 貼回設定中，即可啟動自動發信流程。

---

## 🔒 隱私與安全性聲明
* 您的 API Key 與會議資料 **100% 儲存在您的瀏覽器本機快取 (chrome.storage.local) 中**，擴充功能絕無後台伺服器，絕不會將您的敏感金鑰傳送給任何第三方。
* 只有當您啟用 Webhook 時，擴充功能才會將該場會議紀錄 POST 給您自己架設的 Google Apps Script。

---

## 🧭 Google Drive 錄影自動化（設計中）

本專案正在設計一條可與 Chrome 擴充功能獨立運作的自動化流程：由 Google Apps Script 每 5 分鐘檢查指定 Drive 資料夾，只有發現新錄影時才啟動 Cloud Run 與 AI，以避免空輪詢持續消耗 token。此流程預設以 OpenAI 做說話者分離轉錄與結構化會議摘要，且不自動 fallback 到其他供應商。

完整架構、狀態機、API、安全性與分階段實作方式請見 [Google Drive 自動會議紀錄系統設計](docs/drive-automation-design.md)；帳號、API key 與資料夾的準備方式請見 [OpenAI 優先設定](docs/openai-setup.md)。
