# HANDOFF：Google Drive 自動會議紀錄

更新日期：2026-08-20  
工作區：`C:\Users\USER\Documents\github\auto-meeting-minutes`

## 1. 一句話摘要

目前完成的是「Google Drive 新錄影自動處理」的架構、OpenAI 預設設定與安全設定範本；**尚未實作 Apps Script、Cloud Run、Drive 授權、影音轉錄或 Google Doc 寫入程式，也尚未部署任何服務。**

## 2. 原有專案狀態

此 repository 原本是一個 Google Meet Chrome Extension，主要功能為：

- 擷取 Google Meet CC 字幕。
- 在瀏覽器錄製音訊／影音。
- 使用 Gemini API 整理會議內容。
- 匯出 HTML 報告。
- 透過 Apps Script Webhook 寄信。
- 支援既有 GX10 非同步 LLM Gateway 規劃。

原有的重要檔案包括：

- `background.js`
- `offscreen.js`
- `content.js`
- `popup.js`
- `implementation_plan.md`
- `gx10_api_gateway_plan.md`

本輪沒有修改上述 JavaScript、Chrome manifest 或兩份既有 plan。現有 Chrome Extension 仍以 Gemini 為主要 AI 路徑。

## 3. 本輪已完成

### 3.1 Drive 自動化設計

新增 `docs/drive-automation-design.md`，內容包括：

- Apps Script 每 5 分鐘只檢查 Drive metadata。
- 只有新錄影完成上傳時才啟動 AI，因此空輪詢消耗 0 AI token。
- 以 Drive `fileId` 去重。
- 連續兩輪檔案大小相同後才判斷上傳穩定。
- Google Sheet 作為使用者可見的處理帳本。
- Cloud Run Gateway 接受 job、查詢狀態與提供結果。
- Firestore 保存後端狀態。
- Cloud Run Job 執行 Drive 下載、FFmpeg、轉錄與摘要。
- Apps Script 最後以使用者 Google 帳號建立 Google Doc 並寄信。
- HMAC、重試、狀態機、artifact retention 與分階段驗收方式。

### 3.2 OpenAI 預設設定

依使用者要求，Drive 自動化目前設定為 OpenAI 優先：

```text
AI_PROVIDER=openai
AI_FALLBACK_ENABLED=false
TRANSCRIPTION_PROVIDER=openai
TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize
TRANSCRIPTION_LANGUAGE=zh
SUMMARY_PROVIDER=openai
SUMMARY_MODEL=gpt-5.6-luna
SUMMARY_REASONING_EFFORT=low
SUMMARY_RESPONSE_FORMAT=json_schema
OPENAI_STORE=false
MAX_ACTIVE_JOBS=1
ARTIFACT_RETENTION_DAYS=30
```

設定位置：`.env.example`。

選擇理由：

- `gpt-4o-transcribe-diarize` 提供說話者分離，較適合會議。
- `gpt-5.6-luna` 是成本敏感、高頻率工作的摘要預設。
- 使用 JSON Schema structured output，避免會議紀錄欄位漂移。
- fallback 預設關閉，避免 OpenAI 失敗時自動把會議內容送到其他供應商。

### 3.3 Secret 防護

新增 `.gitignore`：

- 忽略 `.env` 與 `.env.*`。
- 保留 `.env.example` 可提交。
- 忽略常見 service account 與 credentials 檔案。
- 忽略本機 Python runtime artifacts。

真正的 OpenAI API key 尚未建立或寫入 repository。正式規劃是放在 Google Cloud Secret Manager，只允許 Cloud Run processor service account 讀取。

### 3.4 使用者操作指南

新增 `docs/openai-setup.md`，說明：

- 建立 OpenAI API Project。
- 開啟 API billing／credits 與預算提醒。
- 建立 project API key，但不可貼入聊天、Git、Chrome Extension 或 Apps Script 原始碼。
- 建立 Drive 錄影與輸出資料夾。
- 準備非敏感短錄影做第一輪測試。
- 正式部署時將 API key 放入 Secret Manager。

### 3.5 README

`README.md` 新增「Google Drive 錄影自動化（設計中）」區段，明確表示這是與現有 Chrome Extension 獨立的輸入路徑。

## 4. 目前尚未完成

下列功能目前都只有設計，沒有可執行程式：

- `apps-script/` 目錄與 Drive detector。
- 每 5 分鐘的 Apps Script trigger。
- Google Sheet 處理帳本。
- Cloud Run Gateway。
- Cloud Run processor。
- Firestore job 狀態。
- Cloud Storage artifact 保存與清理。
- OpenAI transcription／Responses API 呼叫。
- FFmpeg 音訊切片。
- Google Doc 建立與格式化。
- Email 完成／失敗通知。
- HMAC request 驗證。
- Docker、Terraform、CI 或部署腳本。
- 端到端測試。

目前 repository 中不存在 `apps-script/`、`services/` 或 `infra/` 目錄。

## 5. 成本結論

### OpenAI 路徑

OpenAI API 需要另外依用量付費。選定的 `gpt-4o-transcribe-diarize` 與 `gpt-5.6-luna` 官方模型頁均未提供可依賴的免費 API tier。

作為基準，一般 `gpt-4o-transcribe` 官方估算約 US$0.006／分鐘；說話者分離版依實際 audio token 計費，摘要另依文字 token 計費。實際成本仍受錄影長度、模型、重試與輸出量影響。

### 免費／無 API 費路徑

已提出但**尚未切換設定**的方案：

```text
Apps Script Drive detector
  -> GX10 本機 Whisper / faster-whisper 轉錄
  -> Ollama 本機 LLM 摘要
  -> Apps Script 建立 Google Doc
```

此路徑沒有 OpenAI API 費，但仍有 GX10 電力、網路、維護、儲存與遠端連線成本。

另一個免費方案是繼續使用現有 Chrome Extension 的 Meet CC 擷取，省略音訊轉錄；限制是必須在會議進行時成功捕捉字幕，無法單靠 Drive 錄影重建完整內容。

## 6. 尚待使用者決定

最重要的未決策是 AI 路徑：

1. **維持目前 OpenAI 優先設定**：設定與維護較簡單，但每場會議會產生 API 費用。
2. **改成 GX10 本機優先**：沒有 OpenAI API 費，但需要實作與維護本機轉錄、Ollama 與安全的遠端 job gateway。
3. **GX10 優先、OpenAI 手動備援**：平常免費；本機失敗時由使用者明確選擇是否付費重跑。這是目前最平衡的建議。

在使用者確認以前，`.env.example` 仍保持 OpenAI 優先，未做任何 GX10 切換。

## 7. 實作前仍缺少的資料

- Drive 錄影來源資料夾連結／ID。
- Google Doc 輸出資料夾連結／ID。
- Google 帳號類型：個人 Gmail 或 Google Workspace。
- 通知收件人。
- 是否需要完整逐字稿。
- 典型錄影長度、每週場次與語言。
- 一支 5–10 分鐘、至少兩位說話者、非敏感的測試錄影。
- AI 路徑最終選擇：OpenAI 或 GX10 本機優先。

不要把 OpenAI API key 或 Google service account private key 傳到聊天或提交到 Git。

## 8. 建議下一步

無論最終選 OpenAI 或 GX10，Phase 1 都相同且不使用 AI：

1. 使用者提供來源／輸出資料夾與 Google 帳號類型。
2. 建立 `apps-script/` scaffold。
3. 建立設定表與 Job Ledger。
4. 實作 5 分鐘 trigger、LockService、重疊掃描、檔案穩定判斷與 `fileId` 去重。
5. 以 mock Gateway 驗證三支測試檔只產生三個唯一 job。
6. Phase 1 通過後，再依 AI 決策實作 OpenAI 或 GX10 processor。

## 9. 已做的驗證

- `git diff --check` 通過。
- Markdown code fences 數量平衡。
- `.env.example` 與設計文件的 OpenAI 預設值一致。
- `.env` 經 `git check-ignore` 確認會被忽略。
- `.env.example` 經確認仍可納入版本控制。
- 確認本輪沒有建立或保存任何真實 API key。

未執行功能測試，因為目前沒有新增可執行的 Apps Script 或後端程式。

## 10. 本輪檔案變更

```text
M  README.md
?? .env.example
?? .gitignore
?? HANDOFF.md
?? docs/drive-automation-design.md
?? docs/openai-setup.md
```

這些變更尚未 commit。

## 11. 官方參考資料

- [OpenAI API pricing](https://platform.openai.com/pricing)
- [GPT-4o Transcribe Diarize](https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
- [Apps Script time-driven triggers](https://developers.google.com/apps-script/guides/triggers/installable)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Cloud Run services and jobs](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)
- [Google Drive shared drives and service accounts](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)

