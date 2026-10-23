/**
 * Auto Meeting Minutes - Background Service Worker
 * Manages active sessions, saves history, and writes transcripts using Downloads API.
 */

// Active meeting session state
let activeSession = null;
let isManualStopped = false;
let lastMeetTabInfo = null;
let pendingRecordingPayload = null;
let globalSystemLogsInMemory = [];
const SESSION_RESTORE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes to restore a crashed/reloaded session

// Initialize in-memory logs cache from storage at SW startup
chrome.storage.local.get(['systemLogs'], (res) => {
  globalSystemLogsInMemory = res.systemLogs || [];
  console.log(`[Background] Loaded ${globalSystemLogsInMemory.length} logs from storage.`);
});

// Load settings from storage, returning defaults if not found
const getSettings = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      const defaultSettings = {
        geminiApiKey: '',
        targetEmail: '',
        webhookUrl: '',
        downloadFolder: 'auto-meeting-minutes',
        autoDownloadOnEnd: true,
        autoSummarizeAndWebhook: false,
        autoEnableCC: true,
        summaryModel: 'gemini-3.5-flash',
        promptTemplate: '你是一位專業的會議記錄秘書。請協助我整理會議逐字稿。請務必遵守以下輸出格式，將內容分為兩個區塊，並使用 === [標題] === 包裝：\n\n=== [會議紀錄] ===\n- 會議主旨：[會議主旨名稱]\n- 會議摘要與決議事項：\n  ...（請在此處輸出整理好的條列式會議精要）\n- 待辦事項與指派對象（若有）\n\n=== [優化逐字稿] ===\n（請在此處將輸入的每一句對話，修正其語音辨識錯誤、同音異字並消除贅字，依照發言順序輸出，每行格式固定為：\n[時間 - 說話者]: 優化後的對話內容）',
        recordMode: 'none',
        recordIncludeMic: true
      };
      resolve({ ...defaultSettings, ...result.settings });
    });
  });
};

// Force close any existing offscreen documents upon startup/reload to prevent stale cache
chrome.offscreen.closeDocument().then(() => {
  console.log("[Background] Stale offscreen document closed on startup.");
}).catch(() => {});

// Helper to escape HTML characters
const escapeHtml = (text) => {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const extractSubjectFromSummary = (summary, defaultTitle) => {
  if (!summary) return defaultTitle;
  
  // Look for "會議主旨：xxx" or "**會議主旨**：xxx" or similar variations
  const regex = /(?:會議主旨|會議主題|\*\*會議主旨\*\*|\*\*會議主題\*\*)[：:\s]+([^\n\*\#\|]+)/i;
  const match = summary.match(regex);
  if (match && match[1]) {
    const extracted = match[1].trim();
    if (extracted.length > 3 && extracted.length < 80) {
      return extracted;
    }
  }
  return defaultTitle;
};

const parseMarkdownToHtml = (markdown) => {
  if (!markdown) return '';
  let html = markdown;
  
  // Headers (H6 down to H1)
  html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
  html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
  html = html.replace(/`(.*?)`/gim, '<code>$1</code>');
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
  html = html.replace(/^\s*\*\s+(.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/gim, '');
  
  html = html.split('\n\n').map(para => {
    if (para.trim().startsWith('<h') || para.trim().startsWith('<ul') || para.trim().startsWith('<li')) {
      return para;
    }
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  
  return html;
};

// Convert summary markdown to clean plain text for email
const convertMarkdownToPlainText = (markdown) => {
  if (!markdown) return '';
  
  let lines = markdown.split('\n');
  let result = [];
  let inTable = false;
  let tableHeaders = [];
  let tableRows = [];

  const formatTableToPlainText = (headers, rows) => {
    let output = [];
    rows.forEach((row, rowIndex) => {
      output.push(`[項目 ${rowIndex + 1}]`);
      headers.forEach((header, colIndex) => {
        const val = row[colIndex] || '';
        output.push(`  • ${header}：${val}`);
      });
      output.push('');
    });
    return output.join('\n');
  };

  for (let line of lines) {
    let trimmed = line.trim();
    
    // Handle Markdown Table
    if (trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map(c => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
      
      if (cells.every(c => /^:-*|-*:$/g.test(c) || c === '---' || c === '-')) {
        continue;
      }
      
      if (!inTable) {
        inTable = true;
        tableHeaders = cells;
        tableRows = [];
      } else {
        tableRows.push(cells);
      }
      continue;
    } else {
      if (inTable) {
        result.push(formatTableToPlainText(tableHeaders, tableRows));
        inTable = false;
        tableHeaders = [];
        tableRows = [];
      }
    }

    // Handle Headers
    if (trimmed.startsWith('#')) {
      const match = trimmed.match(/^(#+)\s*(.*)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2];
        if (level === 1) {
          result.push(`\n=== ${text} ===\n`);
        } else if (level === 2) {
          result.push(`\n--- ${text} ---\n`);
        } else {
          result.push(`\n【${text}】`);
        }
        continue;
      }
    }

    // Handle lists
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      let content = trimmed.substring(2);
      content = content.replace(/\*\*(.*?)\*\*/g, '$1');
      result.push(`• ${content}`);
      continue;
    }

    let cleanLine = line.replace(/\*\*(.*?)\*\*/g, '$1');
    result.push(cleanLine);
  }

  if (inTable) {
    result.push(formatTableToPlainText(tableHeaders, tableRows));
  }

  return result.join('\n');
};

// System Logger helper to store rolling logs in local storage
const logEvent = async (module, type, message, sessionId = null, meetingTitle = null) => {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      module: module,
      type: type, // 'info', 'success', 'error', 'warning'
      message: message,
      sessionId: sessionId || (activeSession ? activeSession.id : null),
      meetingTitle: meetingTitle || (activeSession ? activeSession.title : null)
    };
    console.log(`[Logger][${module}][${type}] ${message}`);

    // Store in Service Worker memory
    globalSystemLogsInMemory.unshift(logEntry);
    if (globalSystemLogsInMemory.length > 100) {
      globalSystemLogsInMemory.pop();
    }

    const logs = await new Promise((resolve) => {
      chrome.storage.local.get(['systemLogs'], (res) => {
        resolve(res.systemLogs || []);
      });
    });

    logs.unshift(logEntry);
    if (logs.length > 100) {
      logs.pop(); // Cap logs at 100 entries to prevent storage bloat
    }

    await new Promise((resolve) => {
      chrome.storage.local.set({ systemLogs: logs }, resolve);
    });
  } catch (err) {
    console.error('[Logger] Failed to write log event:', err);
  }
};

// Generate beautiful HTML text from transcript and summary
const formatTranscriptAsHtml = (session) => {
  const dateStr = new Date(session.startTime).toLocaleString('zh-TW');
  
  // Local parser for optimized transcript formatting
  const parseOptimized = (text) => {
    if (!text) return [];
    const lines = text.split('\n');
    const segments = [];
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const match = trimmed.match(/^\[(.*?)\s*-\s*(.*?)\][：:\s]+(.*)$/);
      if (match) {
        segments.push({ timestamp: match[1].trim(), speaker: match[2].trim(), text: match[3].trim() });
      } else {
        // Fallback if formatting differs
        segments.push({ timestamp: "", speaker: "AI 優化", text: trimmed });
      }
    });
    return segments;
  };

  const hasOptimized = !!session.optimizedTranscript;
  const optimizedSegments = hasOptimized ? parseOptimized(session.optimizedTranscript) : [];
  
  let html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>會議紀錄: ${escapeHtml(session.title)}</title>
  <style>
    body {
      background-color: #0f172a;
      color: #f8fafc;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 40px 20px;
      line-height: 1.6;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: rgba(30, 41, 59, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 30px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(12px);
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin-top: 0;
      background: linear-gradient(135deg, #a78bfa 0%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 12px;
    }
    .meta-list {
      list-style: none;
      padding: 0;
      margin: 20px 0;
      font-size: 13.5px;
      color: #94a3b8;
    }
    .meta-list li {
      margin-bottom: 6px;
      display: flex;
      gap: 8px;
    }
    .meta-label {
      font-weight: 600;
      color: #f8fafc;
      min-width: 80px;
    }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #38bdf8;
      border-left: 3px solid #7c3aed;
      padding-left: 10px;
    }
    .summary-box {
      background: rgba(124, 58, 237, 0.08);
      border: 1px solid rgba(124, 58, 237, 0.15);
      border-radius: 8px;
      padding: 16px 20px;
      color: #e2e8f0;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .summary-box h2, .summary-box h3 {
      color: #f8fafc;
      margin-top: 16px;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: ${hasOptimized ? '1fr 1fr' : '1fr'};
      gap: 20px;
      margin-top: 15px;
    }
    @media (max-width: 768px) {
      .comparison-grid {
        grid-template-columns: 1fr;
      }
    }
    .column-header {
      font-size: 13px;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .transcript-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .speech-bubble {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      padding: 12px 16px;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .speech-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }
    .speaker-name {
      font-weight: 600;
      color: #a78bfa;
    }
    .speech-time {
      color: #64748b;
    }
    .speech-text {
      font-size: 14px;
      color: #cbd5e1;
      white-space: pre-wrap;
    }
    .empty-state {
      text-align: center;
      color: #64748b;
      font-style: italic;
      padding: 30px;
    }
    .html-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f8fafc;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .html-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }
    a {
      color: #38bdf8;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>會議紀錄: ${escapeHtml(session.title)}</h1>
    <ul class="meta-list">
      <li><span class="meta-label">會議時間:</span> <span>${dateStr}</span></li>
      <li><span class="meta-label">會議連結:</span> <span><a href="${escapeHtml(session.url)}" target="_blank">${escapeHtml(session.url)}</a></span></li>
    </ul>

    <!-- Copy data store for script -->
    <div id="original-text-content" style="display: none;">${session.transcript ? session.transcript.map(seg => `[${seg.speaker} - ${seg.timestamp}]: ${seg.text}`).join('\n') : ''}</div>
    <div id="optimized-text-content" style="display: none;">${session.optimizedTranscript || ''}</div>
  `;

  if (session.summary) {
    html += `
    <h2 class="section-title">AI 會議精要與待辦事項</h2>
    <div class="summary-box">
      ${parseMarkdownToHtml(session.summary)}
    </div>
  `;
  }

  html += `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 40px; margin-bottom: 15px;">
      <h2 class="section-title" style="margin: 0;">會議對照與逐字稿</h2>
      <div style="display: flex; gap: 8px;">
        <button class="html-btn" onclick="copyText('original-text-content', this)">複製原始對話</button>
        ${hasOptimized ? `<button class="html-btn" onclick="copyText('optimized-text-content', this)">複製優化對話</button>` : ''}
      </div>
    </div>
    
    <div class="comparison-grid">
      <!-- Left Column: Original CC -->
      <div>
        ${hasOptimized ? `<div class="column-header">原始會議發言</div>` : ''}
        <div class="transcript-container">
    `;

  if (!session.transcript || session.transcript.length === 0) {
    html += `      <div class="empty-state">（無擷取到任何字幕內容。請確認會議中是否有開啟 CC 字幕功能）</div>\n`;
  } else {
    session.transcript.forEach((seg) => {
      html += `      <div class="speech-bubble">
        <div class="speech-header">
          <span class="speaker-name">${escapeHtml(seg.speaker)}</span>
          <span class="speech-time">${escapeHtml(seg.timestamp)}</span>
        </div>
        <div class="speech-text">${escapeHtml(seg.text)}</div>
      </div>\n`;
    });
  }

  html += `        </div>
      </div>
    `;

  if (hasOptimized) {
    html += `
      <!-- Right Column: AI Optimized CC -->
      <div>
        <div class="column-header">AI 語意修飾與優化對話</div>
        <div class="transcript-container">
      `;
      
    if (optimizedSegments.length === 0) {
      html += `      <div class="empty-state">（無優化逐字稿對話內容）</div>\n`;
    } else {
      optimizedSegments.forEach((seg) => {
        html += `      <div class="speech-bubble" style="background: rgba(56, 189, 248, 0.03); border-color: rgba(56, 189, 248, 0.08);">
          <div class="speech-header">
            <span class="speaker-name" style="color: #38bdf8;">${escapeHtml(seg.speaker)}</span>
            <span class="speech-time">${escapeHtml(seg.timestamp)}</span>
          </div>
          <div class="speech-text" style="color: #e0f2fe;">${escapeHtml(seg.text)}</div>
        </div>\n`;
      });
    }
      
    html += `        </div>
      </div>
      `;
  }

  html += `    </div>
  </div>
  
  <script>
    function copyText(elementId, btn) {
      const text = document.getElementById(elementId).innerText;
      if (!text || text.trim() === "") {
        alert("無對話內容可複製。");
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerText;
        btn.innerText = '已複製！';
        btn.style.backgroundColor = '#10b981';
        btn.style.borderColor = '#10b981';
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
          btn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
        }, 1500);
      }).catch(err => {
        console.error('Copy failed:', err);
        alert('複製失敗，請手動複製。');
      });
    }
  </script>
</body>
</html>`;

  return html;
};

// Download transcript file using downloads API
const downloadTranscriptFile = async (session) => {
  if (!session) return;
  const settings = await getSettings();
  const folder = settings.downloadFolder ? settings.downloadFolder.trim().replace(/\/$/, '') : 'auto-meeting-minutes';
  
  // Create clean filename based on date and title
  const date = new Date(session.startTime);
  const dateSlug = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
  const cleanTitle = session.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 30);
  const filename = `${folder}/meeting_${dateSlug}_${cleanTitle}.html`;

  const htmlContent = formatTranscriptAsHtml(session);
  const base64Data = btoa(unescape(encodeURIComponent(htmlContent)));
  const dataUrl = `data:text/html;base64,${base64Data}`;

  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    conflictAction: 'uniquify',
    saveAs: false // Download automatically without prompting
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error(`[Background] Download failed:`, chrome.runtime.lastError);
    } else {
      console.log(`[Background] Transcript auto-saved successfully as ${filename} (ID: ${downloadId})`);
    }
  });
};

const updateBackgroundProcessingStatus = async (sessionId, status) => {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(['autoProcessingSessions'], res => {
      resolve(res.autoProcessingSessions || {});
    });
  });
  
  if (status === null) {
    delete result[sessionId];
  } else {
    result[sessionId] = { status: status, timestamp: Date.now() };
  }
  
  await new Promise(resolve => {
    chrome.storage.local.set({ autoProcessingSessions: result }, resolve);
  });
  console.log(`[Background] Updated status of ${sessionId} to: ${status}`);
};

// Run AI summarization and send webhook in the background
const runBackgroundSummarizeAndWebhook = async (session) => {
  const settings = await getSettings();
  const apiKey = settings.geminiApiKey;
  
  const isLlmCustom = settings.llmSource ? (settings.llmSource !== 'gemini') : !!settings.customLlmEnable;
  if (!isLlmCustom && !apiKey) {
    console.warn('[Background] Gemini API Key is missing. Skipping auto-summarization.');
    await updateBackgroundProcessingStatus(session.id, null);
    // Trigger download immediately without summary if auto-download is enabled
    if (settings.autoDownloadOnEnd) {
      await downloadTranscriptFile(session);
    }
    return;
  }

  console.log('[Background] Running auto-summarization for:', session.title);
  logEvent('AI Summary', 'info', `開始進行 AI 整理 (輸入來源: ${settings.aiInputSource || 'text'}, 模型/來源: ${settings.llmSource || 'gemini'})`, session.id, session.title);

  try {
    // Build transcript text
    let transcriptText = "";
    session.transcript.forEach(seg => {
      transcriptText += `[${seg.speaker} - ${seg.timestamp}]: ${seg.text}\n`;
    });

    let finalPrompt = settings.promptTemplate || '';
    if (finalPrompt.includes('{{TRANSCRIPT}}')) {
      finalPrompt = finalPrompt.replace('{{TRANSCRIPT}}', transcriptText);
    } else {
      finalPrompt = `${finalPrompt}\n\n[會議逐字稿]\n${transcriptText}`;
    }

    let summary = '';
    let aiDurationSeconds = null;

    let currentLlmSource = settings.llmSource || (settings.customLlmEnable ? 'custom' : 'gemini');
    if (currentLlmSource === 'gateway') {
      currentLlmSource = 'custom';
    }

    if (currentLlmSource === 'custom') {
      // Custom Async Queue Gateway (Ollama Queue Server on GX10)
      const baseUrl = (settings.customLlmUrl || '').replace(/\/$/, '');
      const apiUrl = `${baseUrl}/meeting-llm/api/jobs`;
      const headers = { 'Content-Type': 'application/json' };
      if (settings.customLlmKey) {
        headers['Authorization'] = `Bearer ${settings.customLlmKey}`;
      }

      const nextcloudFileUrl = (settings.webmUploadTarget === 'nextcloud' && settings.nextcloudWebdavUrl && session.recordingFilename)
        ? `${settings.nextcloudWebdavUrl.replace(/\/$/, '')}/${session.recordingFilename}`
        : null;

      const jobResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          title: session.title,
          prompt: settings.promptTemplate,
          transcript: settings.aiInputSource === 'file' ? null : transcriptText,
          input_type: settings.aiInputSource || 'text',
          nextcloud_url: nextcloudFileUrl
        })
      });

      if (!jobResponse.ok) {
        const errText = await jobResponse.text().catch(() => '');
        throw new Error(`Gateway Server returned status: ${jobResponse.status} ${errText}`);
      }

      const jobData = await jobResponse.json();
      const jobId = jobData.job_id;

      // Poll status every 3 seconds until completed or failed
      summary = await new Promise((resolve, reject) => {
        const pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`${baseUrl}/meeting-llm/api/jobs/${jobId}`);
            if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);

            const jobStatus = await statusRes.json();
            if (jobStatus.status === 'completed') {
              clearInterval(pollInterval);
              aiDurationSeconds = jobStatus.ai_duration_seconds;
              resolve(jobStatus.result);
            } else if (jobStatus.status === 'failed') {
              clearInterval(pollInterval);
              reject(new Error(jobStatus.error || 'Gateway task failed'));
            } else {
              console.log(`[Background] Gateway job ${jobId} status: ${jobStatus.status} (Queue Pos: ${jobStatus.queue_position || 0}, Progress: ${jobStatus.progress_percent || 0}%)`);
            }
          } catch (pollErr) {
            clearInterval(pollInterval);
            reject(pollErr);
          }
        }, 3000);
      });
    } else {
      // Call Google Gemini API via native Fetch
      const model = settings.summaryModel || 'gemini-3.5-flash';
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const requestParts = [];
      if (settings.aiInputSource === 'file' && session.recordingFileUri) {
        console.log("[Background] Sending recording file URI to Gemini for direct multimodal analysis:", session.recordingFileUri);
        requestParts.push({
          fileData: {
            fileUri: session.recordingFileUri,
            mimeType: session.recordingFileMimeType || 'audio/webm'
          }
        });
        requestParts.push({
          text: settings.promptTemplate || '請整理此會議錄音並輸出會議紀錄。'
        });
      } else {
        requestParts.push({
          text: finalPrompt
        });
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: requestParts
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API returned status: ${response.status}`);
      }

      const data = await response.json();
      summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    if (!summary) {
      throw new Error("Failed to find summary text in API response.");
    }

    console.log('[Background] Auto-summarization completed successfully.');
    logEvent('AI Summary', 'success', `AI 整理完成。共分析了 ${session.transcript.length} 句對話。`, session.id, session.title);

    // Parse output: split by "=== [優化逐字稿] ==="
    let summaryText = summary;
    let optimizedTranscript = "";

    const splitTokens = ['=== [優化逐字稿] ===', '===[優化逐字稿]===', '優化逐字稿', '=== [優化對話] ===', '=== [優化逐字稿]'];
    for (const token of splitTokens) {
      if (summary.includes(token)) {
        const parts = summary.split(token);
        summaryText = parts[0].replace('=== [會議紀錄] ===', '').replace('=== [會議記錄] ===', '').trim();
        optimizedTranscript = parts[1].trim();
        break;
      }
    }

    // Save summary, optimized transcript and duration to session
    session.summary = summaryText;
    session.optimizedTranscript = optimizedTranscript;
    session.summaryTime = Date.now();
    if (aiDurationSeconds !== null) {
      session.aiDurationSeconds = aiDurationSeconds;
    }

    // Update history in storage
    const history = await new Promise((resolve) => {
      chrome.storage.local.get(['history'], (res) => {
        resolve(res.history || []);
      });
    });

    const index = history.findIndex(s => s.id === session.id);
    if (index !== -1) {
      history[index].summary = summaryText;
      history[index].optimizedTranscript = optimizedTranscript;
      history[index].summaryTime = Date.now();
      if (aiDurationSeconds !== null) {
        history[index].aiDurationSeconds = aiDurationSeconds;
      }
      await chrome.storage.local.set({ history: history });
      console.log('[Background] Saved auto-summary and optimized transcript to history.');
    }

    // Trigger auto-download if settings allow
    if (settings.autoDownloadOnEnd) {
      await downloadTranscriptFile(session);
    }

    // Send Webhook if configured and enabled
    const shouldSendWebhook = (settings.autoWebhook || settings.autoSummarizeAndWebhook) && settings.webhookUrl;
    if (shouldSendWebhook) {
      await updateBackgroundProcessingStatus(session.id, 'webhook');
      console.log('[Background] Sending auto-webhook to:', settings.webhookUrl);
      logEvent('Email Webhook', 'info', `準備發送自動寄信 Webhook 到：${settings.webhookUrl}`, session.id, session.title);
      
      // Determine target emails based on the configured default email group
      let autoTargetEmail = settings.targetEmail || '';
      if (settings.emailGroups && settings.emailGroups.length > 0) {
        const defaultGroup = settings.defaultAutoGroup;
        const matched = settings.emailGroups.find(g => g.name === defaultGroup);
        if (matched) {
          autoTargetEmail = matched.emails;
        } else {
          autoTargetEmail = settings.emailGroups[0].emails;
        }
      }

      const webhookRes = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain' // Bypass CORS preflight
        },
        body: JSON.stringify({
          id: session.id,
          title: session.title,
          url: session.url,
          startTime: session.startTime,
          startTimeStr: new Date(session.startTime).toISOString(),
          summary: summaryText,
          summaryPlainText: convertMarkdownToPlainText(summaryText),
          summaryHtml: parseMarkdownToHtml(summaryText),
          aiSubject: extractSubjectFromSummary(summaryText, session.title),
          optimizedTranscript: optimizedTranscript,
          transcript: session.transcript,
          targetEmail: autoTargetEmail
        })
      });

      if (!webhookRes.ok) {
        logEvent('Email Webhook', 'error', `寄信 Webhook 發送失敗，狀態碼：${webhookRes.status}`, session.id, session.title);
        console.error('[Background] Webhook failed with status:', webhookRes.status);
      } else {
        logEvent('Email Webhook', 'success', `成功將會議紀錄推送至自動發送 Email 服務 (收件群組: ${autoTargetEmail || '自訂'})`, session.id, session.title);
        console.log('[Background] Webhook sent successfully.');
      }
    }

    // Processing completed successfully, clear status
    await updateBackgroundProcessingStatus(session.id, null);

  } catch (error) {
    logEvent('AI Summary', 'error', `處理整理任務時發生錯誤: ${error.message || error}`, session.id, session.title);
    console.error('[Background] Error during auto-summarization/webhook:', error);
    // Clear processing status
    await updateBackgroundProcessingStatus(session.id, null);
    // Fallback: Trigger download without summary if auto-download is enabled
    if (settings.autoDownloadOnEnd && !session.summary) {
      await downloadTranscriptFile(session);
    }
  }
};

// Finalize active meeting and save to history
const finalizeMeeting = async () => {
  if (!activeSession) return null;
  
  // Stop recording before finalization
  await stopRecordingSession();

  const endedSession = {
    ...activeSession,
    endTime: Date.now()
  };

  // Skip saving if transcript is completely empty
  if (endedSession.transcript && endedSession.transcript.length > 0) {
    const history = await new Promise((resolve) => {
      chrome.storage.local.get(['history'], (res) => {
        resolve(res.history || []);
      });
    });

    history.unshift(endedSession);
    
    // Limit history size to 30 meetings to save storage space
    if (history.length > 30) {
      history.pop();
    }

    await chrome.storage.local.set({ history: history });
    console.log(`[Background] Meeting finalized and saved to history: ${endedSession.title}`);

    // Read settings to check for auto-summarize
    const settings = await getSettings();
    const isAutoSummarize = settings.autoSummarize || settings.autoSummarizeAndWebhook;
    if (isAutoSummarize) {
      await updateBackgroundProcessingStatus(endedSession.id, 'summarizing');
      // Run background summarization (handles download and webhook after summary completes)
      runBackgroundSummarizeAndWebhook(endedSession);
    } else {
      // Otherwise, download raw transcript file immediately
      if (settings.autoDownloadOnEnd) {
        await downloadTranscriptFile(endedSession);
      }
    }
  } else {
    console.log("[Background] Meeting ended with empty transcript. Not saving to history.");
  }

  // Clear active session
  activeSession = null;
  await chrome.storage.local.remove(['activeSession']);
  return endedSession;
};

// Monitor tabs to finalize meeting when tab closes or URL changes
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // If active session tab URL changed away from Google Meet, finalize
  if (activeSession && activeSession.tabId === tabId && changeInfo.url) {
    const meetCodeRegex = /^https:\/\/meet\.google\.com\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?(?:[?#].*)?$/i;
    if (!meetCodeRegex.test(changeInfo.url)) {
      console.log(`[Background] Tab ${tabId} navigated away from Meet. Finalizing meeting...`);
      await finalizeMeeting();
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // If the active session's tab was closed, finalize
  if (activeSession && activeSession.tabId === tabId) {
    console.log(`[Background] Tab ${tabId} closed. Finalizing meeting...`);
    await finalizeMeeting();
  }
});

// Recording session control functions using Offscreen document
const startRecordingSession = async (session) => {
  try {
    const settings = await getSettings();
    if (!settings.recordMode || settings.recordMode === 'none') {
      console.log("[Background] Recording mode is set to none. Skip recording.");
      return;
    }

    const hasDoc = await chrome.offscreen.hasDocument();
    if (session.isRecording && hasDoc) {
      console.log("[Background] Recording is already active. Skip starting.");
      return;
    }

    console.log(`[Background] Starting recording in mode: ${settings.recordMode}`);

    // Generate filename based on current time to make it unique per recording attempt
    const now = new Date();
    const dateStr = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    
    const cleanTitle = session.title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
    const ext = 'webm';
    const filename = `${cleanTitle}_${dateStr}_record.${ext}`;

    const folder = settings.downloadFolder ? settings.downloadFolder.trim().replace(/\/$/, '') : 'auto-meeting-minutes';

    // Create offscreen document if it doesn't exist
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
        justification: 'Record Google Meet tab audio/video and screen/window capture'
      });
      console.log("[Background] Created offscreen document.");
    }

    // Wait a brief moment for document to initialize, then send message
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        targetTabId: session.tabId,
        includeMic: !!settings.recordIncludeMic,
        recordingMode: settings.recordMode,
        filename: `${folder}/${filename}`
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("[Background] Failed to send START_RECORDING to offscreen:", chrome.runtime.lastError.message);
        } else {
          console.log("[Background] START_RECORDING response from offscreen:", response);
        }
      });
    }, 500);

    // Save state to session
    session.isRecording = true;
    session.recordingMode = settings.recordMode;
    session.recordingElapsedSeconds = 0;
    chrome.storage.local.set({ activeSession: session });

  } catch (err) {
    console.error("[Background] Failed to start recording session:", err);
  }
};

const stopRecordingSession = async () => {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      console.log("[Background] Stopping recording in offscreen document...");
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (res) => {
          console.log("[Background] STOP_RECORDING response from offscreen:", res);
          resolve(res);
        });
      });
      
      // If it wasn't recording, we should close it immediately. Otherwise, let DOWNLOAD_RECORDING_BLOB trigger it.
      if (response && (response.status === 'no_active_recording' || response.status === 'error')) {
        await chrome.offscreen.closeDocument();
        console.log("[Background] Closed offscreen document immediately (no active recording).");
      }
    }
  } catch (err) {
    console.error("[Background] Error in stopRecordingSession:", err);
  }
};

const pauseRecordingSession = async () => {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' }).catch(() => {});
    }
  } catch (err) {
    console.error("[Background] Error in pauseRecordingSession:", err);
  }
};

const resumeRecordingSession = async () => {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' }).catch(() => {});
    }
  } catch (err) {
    console.error("[Background] Error in resumeRecordingSession:", err);
  }
};

const createOffscreenDocumentIfNeeded = async () => {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
        justification: 'Record Google Meet tab audio/video and screen/window capture'
      });
      console.log("[Background] Pre-warmed offscreen document.");
    }
  } catch (err) {
    console.error("[Background] Failed to pre-warm offscreen document:", err);
  }
};

const triggerPendingRecording = () => {
  if (!pendingRecordingPayload) return;
  const payload = { ...pendingRecordingPayload };
  const session = payload.session;
  delete payload.session; // Remove internal session ref before sending

  console.log("[Background] Broadcasting START_RECORDING_WITH_STREAM_ID to offscreen...");
  chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) {
      logEvent('Recording', 'error', `無法發送錄製指令至離屏網頁: ${chrome.runtime.lastError.message}`, session.id, session.title);
      console.error("[Background] Failed to send START_RECORDING_WITH_STREAM_ID to offscreen:", chrome.runtime.lastError.message);
      session.isRecording = false;
      chrome.storage.local.set({ activeSession: session });
    } else if (response && response.status === 'error') {
      logEvent('Recording', 'error', `錄製啟動失敗: ${response.error}`, session.id, session.title);
      console.error("[Background] Offscreen start recording error:", response.error);
      session.isRecording = false;
      chrome.storage.local.set({ activeSession: session });
    } else {
      console.log("[Background] START_RECORDING_WITH_STREAM_ID response from offscreen:", response);
    }
  });
  pendingRecordingPayload = null;
};

const startRecordingSessionWithStreamId = async (session, tabStreamId, desktopStreamId = null, captureSourceOverride = null) => {
  try {
    const settings = await getSettings();
    const captureSource = captureSourceOverride || settings.captureSource || 'tab';
    logEvent('Recording', 'info', `啟動語音/影像錄製 (模式: ${settings.recordMode || 'audio'}, 來源: ${captureSource})`, session.id, session.title);
    console.log(`[Background] Starting recording session with streamId...`);

    // Generate filename based on current time to make it unique per recording attempt
    const now = new Date();
    const dateStr = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    
    const cleanTitle = session.title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
    const ext = 'webm';
    const filename = `${cleanTitle}_${dateStr}_record.${ext}`;

    const folder = settings.downloadFolder ? settings.downloadFolder.trim().replace(/\/$/, '') : 'auto-meeting-minutes';

    pendingRecordingPayload = {
      type: 'START_RECORDING_WITH_STREAM_ID',
      tabStreamId: tabStreamId,
      desktopStreamId: desktopStreamId,
      includeMic: !!settings.recordIncludeMic,
      recordingMode: settings.recordMode || 'audio',
      captureSource: captureSource,
      filename: `${folder}/${filename}`,
      settings: {
        webmUploadTarget: settings.webmUploadTarget || 'none',
        webmWebhookUrl: settings.webmWebhookUrl,
        nextcloudWebdavUrl: settings.nextcloudWebdavUrl,
        nextcloudUsername: settings.nextcloudUsername,
        nextcloudPassword: settings.nextcloudPassword,
        aiInputSource: settings.aiInputSource || 'text',
        geminiApiKey: settings.geminiApiKey,
        llmSource: settings.llmSource || 'gemini'
      },
      session: session
    };

    // Create offscreen document if it doesn't exist
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
        justification: 'Record Google Meet tab audio/video and screen/window capture'
      });
      console.log("[Background] Created offscreen document.");
    } else {
      console.log("[Background] Offscreen document already exists. Triggering immediately...");
      triggerPendingRecording();
    }

    // Save state to session
    session.isRecording = true;
    session.recordingMode = settings.recordMode || 'audio';
    session.recordingElapsedSeconds = 0;
    session.recordingFilename = filename;
    chrome.storage.local.set({ activeSession: session });

  } catch (err) {
    logEvent('Recording', 'error', `啟動錄製程序發生嚴重錯誤: ${err.message || err}`, session.id, session.title);
    console.error("[Background] Failed to start recording session with streamId:", err);
  }
};

// Handle messages from content.js or popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_MEETING_INFO') {
    if (!sender.tab) {
      sendResponse({ status: 'error', message: 'No tab context' });
      return;
    }
    const tabId = sender.tab.id;
    const title = message.meetingTitle || 'Google Meet';
    const url = message.url;

    lastMeetTabInfo = { tabId, title, url };
    createOffscreenDocumentIfNeeded();

    if (!activeSession) {
      if (isManualStopped) {
        console.log(`[Background] SYNC_MEETING_INFO ignored because meeting was manually stopped.`);
        sendResponse({ status: 'sync_ignored_manual_stopped' });
        return;
      }
      // Check if we can restore a very recent session (e.g. user reloaded page)
      chrome.storage.local.get(['activeSession'], (result) => {
        const stored = result.activeSession;
        if (stored && stored.url === url && (Date.now() - stored.lastUpdateTime < SESSION_RESTORE_WINDOW_MS)) {
          // Restore session
          activeSession = stored;
          activeSession.tabId = tabId;
          activeSession.title = title;
          console.log(`[Background] Session restored for url: ${url}`);
          chrome.storage.local.set({ activeSession: activeSession });
        } else {
          // Create new session
          activeSession = {
            id: 'meet_' + Date.now(),
            tabId: tabId,
            title: title,
            url: url,
            startTime: Date.now(),
            transcript: [],
            isCapturing: true,
            isObserving: false,
            lastUpdateTime: Date.now()
          };
          console.log(`[Background] New session created for url: ${url}`);
          chrome.storage.local.set({ activeSession: activeSession });
        }
      });
    } else {
      // Update existing session tab details
      activeSession.tabId = tabId;
      activeSession.title = title;
      chrome.storage.local.set({ activeSession: activeSession });
    }
    sendResponse({ status: 'synced' });
  }

  else if (message.type === 'SET_MEETING_STATUS') {
    if (activeSession) {
      activeSession.isCapturing = message.isCapturing;
      activeSession.isObserving = message.isObserving;
      activeSession.lastUpdateTime = Date.now();
      chrome.storage.local.set({ activeSession: activeSession });
    }
    sendResponse({ status: 'status_updated' });
  }

  else if (message.type === 'SET_CAPTURE_STATE') {
    if (activeSession) {
      activeSession.isCapturing = message.isCapturing;
      activeSession.lastUpdateTime = Date.now();
      chrome.storage.local.set({ activeSession: activeSession });
      
      // Sync recording state with capture state
      if (message.isCapturing) {
        resumeRecordingSession();
      } else {
        pauseRecordingSession();
      }
    }
    sendResponse({ status: 'capture_state_updated' });
  }

  else if (message.type === 'UPDATE_TRANSCRIPT') {
    if (isManualStopped) {
      sendResponse({ status: 'update_ignored_manual_stopped' });
      return;
    }
    if (activeSession) {
      activeSession.transcript = message.transcript;
      activeSession.title = message.meetingTitle || activeSession.title;
      activeSession.lastUpdateTime = Date.now();
      chrome.storage.local.set({ activeSession: activeSession });
    } else {
      // Session wasn't active, recreate it
      const tabId = sender.tab ? sender.tab.id : null;
      activeSession = {
        id: 'meet_' + Date.now(),
        tabId: tabId,
        title: message.meetingTitle || 'Google Meet',
        url: message.url,
        startTime: Date.now(),
        transcript: message.transcript,
        isCapturing: true,
        isObserving: true,
        lastUpdateTime: Date.now()
      };
      chrome.storage.local.set({ activeSession: activeSession });
    }
    sendResponse({ status: 'transcript_updated' });
  }

  else if (message.type === 'GET_ACTIVE_SESSION') {
    sendResponse({ 
      activeSession: activeSession,
      lastMeetTab: lastMeetTabInfo,
      isManualStopped: isManualStopped
    });
  }

  else if (message.type === 'FORCE_FINALIZE_MEETING') {
    finalizeMeeting().then((endedSession) => {
      isManualStopped = true;
      if (endedSession && endedSession.tabId) {
        chrome.tabs.sendMessage(endedSession.tabId, { type: 'STOP_AND_CLEAR' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
      sendResponse({ status: 'finalized', session: endedSession });
    });
    return true; // Keep response channel open for async handler
  }

  else if (message.type === 'START_NEW_MEETING') {
    isManualStopped = false;
    if (lastMeetTabInfo) {
      activeSession = {
        id: 'meet_' + Date.now(),
        tabId: lastMeetTabInfo.tabId,
        title: lastMeetTabInfo.title,
        url: lastMeetTabInfo.url,
        startTime: Date.now(),
        transcript: [],
        isCapturing: true,
        isObserving: true,
        lastUpdateTime: Date.now()
      };
      chrome.storage.local.set({ activeSession: activeSession });
      createOffscreenDocumentIfNeeded();

      // Notify content script to start fresh capturing
      chrome.tabs.sendMessage(lastMeetTabInfo.tabId, { type: 'START_CAPTURING' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    sendResponse({ status: 'started', activeSession: activeSession });
  }

  else if (message.type === 'DOWNLOAD_SESSION') {
    downloadTranscriptFile(message.session).then(() => {
      sendResponse({ status: 'downloaded' });
    });
    return true;
  }

  else if (message.type === 'TOGGLE_MANUAL_RECORDING') {
    if (activeSession) {
      if (activeSession.isRecording) {
        stopRecordingSession().then(() => {
          activeSession.isRecording = false;
          chrome.storage.local.set({ activeSession: activeSession });
          sendResponse({ status: 'stopped' });
        }).catch(err => {
          sendResponse({ status: 'error', error: err.message });
        });
      } else {
        // Request getMediaStreamId synchronously under user gesture context first
        chrome.tabCapture.getMediaStreamId({ targetTabId: activeSession.tabId }, (streamId) => {
          if (chrome.runtime.lastError) {
            console.error("[Background] getMediaStreamId failed:", chrome.runtime.lastError.message);
            sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
            return;
          }

          console.log("[Background] Got streamId synchronously:", streamId);

          getSettings().then(async (settings) => {
            if (!settings.recordMode || settings.recordMode === 'none') {
              settings.recordMode = 'audio';
              await chrome.storage.local.set({ settings: settings });
            }
            await startRecordingSessionWithStreamId(activeSession, streamId, null, 'tab');
            sendResponse({ status: 'started' });
          }).catch(err => {
            sendResponse({ status: 'error', error: err.message });
          });
        });
      }
      return true; // Keep message channel open for async callback
    } else {
      sendResponse({ status: 'error', message: 'No active session' });
    }
  }

  else if (message.type === 'TRIGGER_DESKTOP_CAPTURE') {
    if (activeSession) {
      const tabStreamId = message.tabStreamId;
      chrome.tabs.get(activeSession.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          logEvent('Recording', 'error', '找不到會議分頁，無法啟動畫面分享選取。');
          sendResponse({ status: 'error', error: 'No active tab' });
          return;
        }
        
        // Show sharing dialog overlaying the Meet tab
        const desktopCaptureId = chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab'], tab, (streamId) => {
          if (chrome.runtime.lastError || !streamId) {
            logEvent('Recording', 'info', '使用者取消了畫面共用選取。');
            console.log("[Background] User cancelled or chooseDesktopMedia failed:", chrome.runtime.lastError?.message);
            return;
          }
          
          console.log("[Background] Retrieve desktop capture streamId:", streamId);
          
          getSettings().then(async (settings) => {
            if (!settings.recordMode || settings.recordMode === 'none') {
              settings.recordMode = 'audio';
              await chrome.storage.local.set({ settings: settings });
            }
            await startRecordingSessionWithStreamId(activeSession, tabStreamId, streamId, 'desktop');
          }).catch(err => {
            logEvent('Recording', 'error', `啟動錄製錯誤: ${err.message}`);
          });
        });
        
        sendResponse({ status: 'dialog_shown', desktopCaptureId });
      });
      return true;
    } else {
      sendResponse({ status: 'error', error: 'No active session' });
    }
  }

  else if (message.type === 'START_RECORDING_WITH_STREAM_ID_FROM_POPUP') {
    if (activeSession) {
      getSettings().then(async (settings) => {
        if (!settings.recordMode || settings.recordMode === 'none') {
          settings.recordMode = 'audio';
          await chrome.storage.local.set({ settings: settings });
        }
        await startRecordingSessionWithStreamId(activeSession, message.streamId, null, message.captureSource);
        sendResponse({ status: 'started' });
      }).catch(err => {
        sendResponse({ status: 'error', error: err.message });
      });
      return true;
    } else {
      sendResponse({ status: 'error', message: 'No active session' });
    }
  }

  else if (message.type === 'START_RECORDING_WITH_DOUBLE_STREAM') {
    if (activeSession) {
      getSettings().then(async (settings) => {
        if (!settings.recordMode || settings.recordMode === 'none') {
          settings.recordMode = 'audio';
          await chrome.storage.local.set({ settings: settings });
        }
        await startRecordingSessionWithStreamId(activeSession, message.tabStreamId, message.desktopStreamId, 'desktop');
        sendResponse({ status: 'started' });
      }).catch(err => {
        logEvent('Recording', 'error', `啟動錄製錯誤: ${err.message}`);
        sendResponse({ status: 'error', error: err.message });
      });
      return true;
    } else {
      sendResponse({ status: 'error', error: 'No active session' });
    }
  }

  else if (message.type === 'DOWNLOAD_RECORDING_BLOB') {
    logEvent('Recording', 'info', `準備下載本機備份影音檔：「${message.filename}」`);
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        logEvent('Recording', 'error', `下載本機備份影音檔失敗: ${chrome.runtime.lastError.message}`);
        console.error("[Background] Recording download failed:", chrome.runtime.lastError.message);
        sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
      } else {
        logEvent('Recording', 'success', `已成功開始下載本機備份影音檔：「${message.filename}」`);
        console.log(`[Background] Recording download started: ID ${downloadId}`);
        sendResponse({ status: 'success', downloadId: downloadId });
      }

      // Close the offscreen document only after the download task has been accepted by Chrome
      chrome.offscreen.closeDocument().then(() => {
        console.log("[Background] Closed offscreen document after download initiated.");
      }).catch(err => {
        console.error("[Background] Error closing offscreen document:", err);
      });
    });
    return true;
  }

  else if (message.type === 'GET_SYSTEM_LOGS') {
    sendResponse({ logs: globalSystemLogsInMemory });
    return true;
  }

  else if (message.type === 'CLEAR_SYSTEM_LOGS') {
    globalSystemLogsInMemory = [];
    chrome.storage.local.set({ systemLogs: [] }, () => {
      sendResponse({ status: 'cleared' });
    });
    return true;
  }

  else if (message.type === 'PRE_WARM_OFFSCREEN') {
    createOffscreenDocumentIfNeeded().then(() => {
      sendResponse({ status: 'prewarmed' });
    });
    return true;
  }

  else if (message.type === 'OFFSCREEN_READY') {
    console.log("[Background] Offscreen reported READY. Triggering pending recording payload...");
    triggerPendingRecording();
    sendResponse({ status: 'ok' });
    return true;
  }

  else if (message.type === 'ADD_LOG_ENTRY') {
    logEvent(message.module, message.logType, message.message, message.sessionId, message.meetingTitle).then(() => {
      sendResponse({ status: 'logged' });
    });
    return true;
  }

  else if (message.type === 'RECORDING_UPLOAD_STATE') {
    if (activeSession) {
      chrome.tabs.sendMessage(activeSession.tabId, {
        type: 'RECORDING_UPLOAD_STATE_FORWARD',
        state: message.state,
        error: message.error
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    sendResponse({ status: 'ok' });
  }

  else if (message.type === 'RECORDING_TICK') {
    if (activeSession) {
      activeSession.recordingElapsedSeconds = message.elapsedSeconds;
      chrome.storage.local.set({ activeSession: activeSession });
      
      // Forward recording tick to Google Meet page
      chrome.tabs.sendMessage(activeSession.tabId, {
        type: 'RECORDING_TICK_FORWARD',
        elapsedSeconds: message.elapsedSeconds
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    sendResponse({ status: 'ok' });
  }
  else if (message.type === 'UPDATE_SESSION_RECORDING_URI') {
    chrome.storage.local.get(['activeSession'], (res) => {
      const sess = res.activeSession;
      if (sess) {
        sess.recordingFileUri = message.recordingFileUri;
        sess.recordingFileMimeType = message.recordingFileMimeType;
        chrome.storage.local.set({ activeSession: sess }, () => {
          console.log("[Background] Session recording URI updated in storage:", message.recordingFileUri);
          sendResponse({ status: 'updated' });
        });
      } else {
        console.warn("[Background] No active session found to update recording URI.");
        sendResponse({ status: 'no_session' });
      }
    });
    return true; // Keep message channel open for async response
  }
});

// Clean up any dangling background processing sessions on Service Worker start
const cleanupDanglingSessionsOnStart = async () => {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(['autoProcessingSessions'], res => {
      resolve(res.autoProcessingSessions || {});
    });
  });
  
  let changed = false;
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  
  for (const sessionId in result) {
    const session = result[sessionId];
    if (session.timestamp && (now - session.timestamp > TEN_MINUTES)) {
      console.log(`[Background] Cleaning up dangling session on startup: ${sessionId}`);
      delete result[sessionId];
      changed = true;
    }
  }
  
  if (changed) {
    await new Promise(resolve => {
      chrome.storage.local.set({ autoProcessingSessions: result }, resolve);
    });
  }
};

cleanupDanglingSessionsOnStart();
