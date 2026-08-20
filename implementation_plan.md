# Google Meet 實際會議錄音/錄影功能實作計畫

本計畫旨在為 Chrome 擴充功能加入**實際錄製會議聲音與影像**的功能，而非僅擷取 CC 字幕。這將為用戶提供更完整的會議存檔，支援後續查證或更精準的 AI 語音轉文字整理。

---

## 瀏覽器安全限制與技術架構

在 Chrome Extension Manifest V3 中，背景 Service Worker (`background.js`) 無法直接存取多媒體裝置（Media Devices）。為此，我們將採用 Chrome 官方推薦的 **Offscreen Document (離屏文件)** 機制來處理錄製：

1. **離屏文件機制 (Offscreen Document)**：
   - 當用戶啟動錄製時，`background.js` 會在背景靜態建立一個隱形頁面 `offscreen.html`。
   - `offscreen.js` 將負責獲取媒體串流、執行錄製編碼，並在錄製結束時將影音檔案傳回背景下載。

2. **雙聲道混音 (Audio Mixing)**：
   - **Google Meet 標籤頁聲音**：擷取其他會議參與者的聲音與簡報音效。
   - **麥克風輸入聲音**：擷取用戶自己說話的聲音。
   - **Web Audio 混音**：使用 `AudioContext` 將「標籤頁聲音」與「麥克風聲音」混合成單一音軌，確保錄音檔中**同時有自己與對方的聲音**。

3. **錄製模式選擇**：
   - **僅錄音 (Audio Only)**：輸出為 `.webm` (音訊編碼為 Opus)，檔案小、適合儲存語音。
   - **錄製影音 (Video + Audio)**：輸出為 `.webm` (影音編碼為 VP8/VP9 + Opus)，完整儲存會議畫面與聲音。

---

## 使用者審查要點

> [!IMPORTANT]
> 1. **瀏覽器授權提示**：為了啟用錄製，瀏覽器在**首次啟動錄製時會彈出「麥克風存取權限」與「共用此分頁的音訊」**的系統提示。這是瀏覽器的隱私安全限制，使用者必須點選「允許」與「分享」才能正常錄音。
> 2. **儲存空間與下載**：錄製完成的影音檔案將在會議「結束並整理」時，自動透過 `chrome.downloads` 下載至您的 Chrome 下載目錄下（如 `Downloads/auto-meeting-minutes/`）。

---

## 開放問題 (Open Questions)

> [!IMPORTANT]
> 1. **混音選項**：是否預設「自動開啟麥克風並混音」？（若關閉此選項，錄音中將只有其他參與者的聲音，不會有使用者自己的聲音）。
> 2. **自動下載**：錄製檔案是否應與會議逐字稿一同適用「會議結束自動下載」設定？還是獨立為一個「是否自動下載錄製檔」的勾選項目？
> 3. **檔案格式限制**：基於 Chrome 原生編碼器限制，錄製產出的預設格式為 `.webm`。如果需要轉成 `.mp3` / `.mp4`，需要在瀏覽器端載入龐大的 FFmpeg.wasm（這會增加外掛大小並耗費大量記憶體與 CPU 資源）。我們是否維持使用輕量高效的 `.webm` 格式？

---

## 預估變更範圍 (Proposed Changes)

### 1. 設定與核心配置

#### [MODIFY] [manifest.json](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/manifest.json)
- 新增 `"offscreen"`、`"tabCapture"` 權限以支援離屏錄製。
- 註冊 `offscreen.html` 相關權限。

#### [NEW] [offscreen.html](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/offscreen.html)
- 隱藏的背景 HTML 容器，用於載入 `offscreen.js`。

#### [NEW] [offscreen.js](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/offscreen.js)
- 呼叫 `chrome.tabCapture.getMediaStreamId` 獲取分頁影音串流。
- 呼叫 `navigator.mediaDevices.getUserMedia` 獲取麥克風音軌.
- 透過 `AudioContext` 混音（麥克風 + 分頁聲音）。
- 使用 `MediaRecorder` 實作暫停、繼續、錄製與分片快取。
- 錄製結束時，將資料組合成 `Blob` 並發送 `chrome.runtime` 訊息通知背景下載。

### 2. UI 操作面板更新

#### [MODIFY] [popup.html](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/popup.html)
- 在「會議錄製」與「設定」分頁中加入錄製配置區塊：
  - 新增下拉選單：**錄製模式**（`不錄製` / `僅錄製聲音` / `錄製影音畫面`）。
  - 新增勾選框：**包含我的麥克風聲音 (混音)**。
- 在錄製狀態條中，若開啟錄製，會額外顯示「🔴 影音錄製中 00:00:00」計時器與錄製狀態。

#### [MODIFY] [popup.js](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/popup.js)
- 載入並儲存錄影設定。
- 在啟動/暫停會議時，同步發送控制指令至背景，以建立/操作離屏錄製頁面。

### 3. 背景協調控制

#### [MODIFY] [background.js](file:///c:/Users/USER/Documents/github/auto-meeting-minutes/background.js)
- 管理離屏文件 `offscreen.html` 的生命週期（建立、開啟、銷毀）。
- 接收來自 `offscreen.js` 的錄製完成資料，透過 `chrome.downloads` 下載影音檔案（例如 `meeting_20260708_2330_record.webm`）。
- 監聽會議分頁關閉事件，自動強制停止錄影並保存，防止資料遺失。

---

## 驗證計畫

### 1. 自動錄製功能驗證
- 開啟 Google Meet，設定選取「僅錄製聲音 + 包含麥克風混音」。
- 啟動會議，允許麥克風與共用分頁音訊權限。
- 進行模擬對話（同時由麥克風說話，並由 Meet 分頁播放聲音）。
- 點擊「結束並整理」，驗證是否成功下載 `.webm` 錄音檔，且播放時同時有自己與對方的聲音。

### 2. 影音同步驗證
- 設定選取「錄製影音畫面」。
- 開啟會議並分享畫面，結束後下載 `.webm` 影片檔，驗證畫面與聲音是否同步且無卡頓。
