# OpenAI 優先設定與使用者準備步驟

狀態：預設值已確定；後端尚待 Phase 2–3 實作與部署。  
日期：2026-08-20

## 已設定的預設值

Drive 自動化後端將優先且預設只使用 OpenAI：

```text
AI_PROVIDER=openai
AI_FALLBACK_ENABLED=false
TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize
SUMMARY_MODEL=gpt-5.6-luna
SUMMARY_REASONING_EFFORT=low
SUMMARY_RESPONSE_FORMAT=json_schema
OPENAI_STORE=false
```

選擇理由：

- `gpt-4o-transcribe-diarize` 可將語音片段關聯到不同說話者，適合會議錄音。
- `gpt-5.6-luna` 適合成本敏感、高頻率工作，並支援 structured outputs。
- `json_schema` 可強制摘要符合會議紀錄 schema，降低排版或欄位遺失。
- `AI_FALLBACK_ENABLED=false` 可避免 OpenAI 暫時失敗時，會議內容未經確認被送到其他供應商。

如果實測發現摘要品質不足，只需將 `SUMMARY_MODEL` 改成 `gpt-5.6-terra`，不必改架構。

## 你現在需要做的事

### 1. 建立 OpenAI API Project

1. 前往 [OpenAI Platform](https://platform.openai.com/)。
2. 建立專用 project，建議命名為 `auto-meeting-minutes`。
3. 在該 project 設定 API billing／credits 與預算提醒。
4. 建立一把 project API key。
5. 將 key 存入密碼管理器，先不要貼到聊天室，也不要寫入 Git、Chrome 擴充功能或 Apps Script 原始碼。

API 使用量會在 OpenAI Platform 的 Usage／Costs 中追蹤；正式處理錄影前應先設定你能接受的預算。

### 2. 建立兩個 Google Drive 資料夾

建立並保留連結：

1. `Meeting Recordings`：錄影來源資料夾。
2. `Meeting Minutes`：Google Doc 輸出資料夾。

把這兩個資料夾的分享連結提供給開發流程即可；不要把 OpenAI API key 放進資料夾或文件。

### 3. 確認 Google 帳號類型

記下你使用的是：

- 個人 Gmail，或
- Google Workspace 公司／學校帳號。

這會影響 Apps Script 授權、Shared Drive 與管理員允許的 OAuth scope，但不改變 OpenAI 模型設定。

### 4. 準備測試資料

建議先準備一支：

- 長度 5–10 分鐘；
- 至少兩位說話者；
- 不含高度敏感內容；
- 格式為目前實際會議服務產生的 MP4 或 WebM。

第一輪驗證只測偵測、去重與 mock 結果，不會立即把影片送到 OpenAI。影音上傳會等後端、權限與預算限制都驗證後才啟用。

## API Key 最終放置方式

正式部署時：

1. 在 Google Cloud Secret Manager 建立 `openai-api-key` secret。
2. 將真正的 API key 儲存在 secret version 中。
3. 只授權 Cloud Run processor service account 讀取該 secret。
4. Cloud Run 以 `OPENAI_API_KEY` 環境變數掛載 secret。
5. Apps Script、Google Sheet、瀏覽器與 Git 都不持有這把 key。

本機開發時才把 `.env.example` 複製成 `.env`；`.gitignore` 已設定禁止提交 `.env`。

## 接下來的實作順序

1. Phase 1：Apps Script Drive detector，完全不呼叫 OpenAI。
2. Phase 2：Cloud Run Gateway、Firestore 狀態與 mock processor。
3. Phase 3：加入 OpenAI 轉錄與 structured summary。
4. 用 5–10 分鐘錄影驗證後，再測長會議與成本。

## 官方 OpenAI 文件

- [GPT-4o Transcribe Diarize](https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Responses structured outputs](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
- [OpenAI API quickstart and API keys](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
- [OpenAI API usage and costs](https://platform.openai.com/docs/api-reference/usage/audio_transcriptions_object)

