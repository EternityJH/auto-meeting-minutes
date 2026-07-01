/**
 * Auto Meeting Minutes - Background Service Worker
 * Manages active sessions, saves history, and writes transcripts using Downloads API.
 */

// Active meeting session state
let activeSession = null;
const SESSION_RESTORE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes to restore a crashed/reloaded session

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
        promptTemplate: '你是一位專業的會議記錄秘書。請協助我整理會議逐字稿。請務必遵守以下輸出格式，將內容分為兩個區塊，並使用 === [標題] === 包裝：\n\n=== [會議紀錄] ===\n- 會議主旨：[會議主旨名稱]\n- 會議摘要與決議事項：\n  ...（請在此處輸出整理好的條列式會議精要）\n- 待辦事項與指派對象（若有）\n\n=== [優化逐字稿] ===\n（請在此處將輸入的每一句對話，修正其語音辨識錯誤、同音異字並消除贅字，依照發言順序輸出，每行格式固定為：\n[時間 - 說話者]: 優化後的對話內容）'
      };
      resolve({ ...defaultSettings, ...result.settings });
    });
  });
};

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
  
  if (!apiKey) {
    console.warn('[Background] Gemini API Key is missing. Skipping auto-summarization.');
    await updateBackgroundProcessingStatus(session.id, null);
    // Trigger download immediately without summary if auto-download is enabled
    if (settings.autoDownloadOnEnd) {
      await downloadTranscriptFile(session);
    }
    return;
  }

  console.log('[Background] Running auto-summarization for:', session.title);

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
    const model = settings.summaryModel || 'gemini-3.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: finalPrompt
          }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned status: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!summary) {
      throw new Error("Failed to find summary text in API response.");
    }

    console.log('[Background] Auto-summarization completed successfully.');

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

    // Save summary and optimized transcript to session
    session.summary = summaryText;
    session.optimizedTranscript = optimizedTranscript;

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
          targetEmail: settings.targetEmail
        })
      });

      if (!webhookRes.ok) {
        console.error('[Background] Webhook failed with status:', webhookRes.status);
      } else {
        console.log('[Background] Webhook sent successfully.');
      }
    }

    // Processing completed successfully, clear status
    await updateBackgroundProcessingStatus(session.id, null);

  } catch (error) {
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
    const meetCodeRegex = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
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

// Handle messages from content.js or popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_MEETING_INFO') {
    const tabId = sender.tab.id;
    const title = message.meetingTitle || 'Google Meet';
    const url = message.url;

    if (!activeSession) {
      // Check if we can restore a very recent session (e.g. user reloaded page)
      chrome.storage.local.get(['activeSession'], (result) => {
        const stored = result.activeSession;
        if (stored && stored.url === url && (Date.now() - stored.lastUpdateTime < SESSION_RESTORE_WINDOW_MS)) {
          // Restore session
          activeSession = stored;
          activeSession.tabId = tabId;
          activeSession.title = title;
          console.log(`[Background] Session restored for url: ${url}`);
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
        }
        chrome.storage.local.set({ activeSession: activeSession });
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
    }
    sendResponse({ status: 'capture_state_updated' });
  }

  else if (message.type === 'UPDATE_TRANSCRIPT') {
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
    sendResponse({ activeSession: activeSession });
  }

  else if (message.type === 'FORCE_FINALIZE_MEETING') {
    finalizeMeeting().then((endedSession) => {
      sendResponse({ status: 'finalized', session: endedSession });
    });
    return true; // Keep response channel open for async handler
  }

  else if (message.type === 'DOWNLOAD_SESSION') {
    downloadTranscriptFile(message.session).then(() => {
      sendResponse({ status: 'downloaded' });
    });
    return true;
  }
});
