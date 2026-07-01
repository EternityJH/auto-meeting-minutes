/**
 * Auto Meeting Minutes - Popup Dashboard JS
 * Handles UI interactions, settings, Gemini AI summarization, and exporting.
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- UI Elements ---
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const headerPulse = document.getElementById('header-pulse');

  // Active Recording Tab elements
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const meetingTitle = document.getElementById('meeting-title');
  const meetingUrl = document.getElementById('meeting-url');
  const lineCount = document.getElementById('line-count');
  const wordCount = document.getElementById('word-count');
  const recordTime = document.getElementById('record-time');
  const liveTranscript = document.getElementById('live-transcript');
  const btnToggleCapture = document.getElementById('btn-toggle-capture');
  const btnEndMeeting = document.getElementById('btn-end-meeting');

  // History & AI Tab elements
  const historyListContainer = document.getElementById('history-list-container');
  const selectedTitle = document.getElementById('selected-title');
  const selectedDate = document.getElementById('selected-date');
  const btnDownloadRaw = document.getElementById('btn-download-raw');
  const btnCopyRaw = document.getElementById('btn-copy-raw');
  const summaryResultBox = document.getElementById('summary-result-box');
  const summaryContent = document.getElementById('summary-content');
  const aiPlaceholderMsg = document.getElementById('ai-placeholder-msg');
  const workspaceFooter = document.getElementById('workspace-footer');
  const btnRunAi = document.getElementById('btn-run-ai');
  const exportActionsRow = document.getElementById('export-actions-row');
  const btnEmail = document.getElementById('btn-email');
  const btnWebhook = document.getElementById('btn-webhook');
  const btnCopy = document.getElementById('btn-copy');
  const btnDownloadHtml = document.getElementById('btn-download-html');

  // Settings Tab elements
  const inputGeminiKey = document.getElementById('gemini-key');
  const selectGeminiModel = document.getElementById('gemini-model');
  const inputTargetEmail = document.getElementById('target-email');
  const inputWebhookUrl = document.getElementById('webhook-url');
  const inputDownloadFolder = document.getElementById('download-folder');
  const checkboxAutoDownload = document.getElementById('auto-download');
  const checkboxAutoSummarize = document.getElementById('auto-summarize');
  const checkboxAutoWebhook = document.getElementById('auto-webhook');
  const labelAutoWebhook = document.getElementById('label-auto-webhook');
  const checkboxAutoEnableCC = document.getElementById('auto-enable-cc');
  const textareaPromptTemplate = document.getElementById('prompt-template');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const saveStatus = document.getElementById('save-status');

  // --- State Variables ---
  let activeTab = 'active-recording';
  let activePollingInterval = null;
  let selectedMeeting = null; // Currently selected meeting from history
  let globalSettings = {};

  // --- Tab Switching ---
  const switchTab = (tabId) => {
    activeTab = tabId;
    tabButtons.forEach(btn => {
      if (btn.getAttribute('data-tab') === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    tabContents.forEach(content => {
      if (content.id === tabId) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    // Handle tab-specific initializations
    if (tabId === 'active-recording') {
      startActiveRecordingPolling();
    } else {
      stopActiveRecordingPolling();
      if (tabId === 'history-ai') {
        loadHistoryList();
      }
    }
  };

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // Dynamic validation for webhook settings
  const updateWebhookSettingsUI = () => {
    const hasWebhookUrl = !!inputWebhookUrl.value.trim();
    const isAutoSummarize = checkboxAutoSummarize.checked;

    // Enable/disable webhook automatic sending checkbox
    if (hasWebhookUrl && isAutoSummarize) {
      checkboxAutoWebhook.disabled = false;
      labelAutoWebhook.style.opacity = '1';
      labelAutoWebhook.innerText = 'AI 整理完成後自動傳送 Webhook';
    } else {
      checkboxAutoWebhook.disabled = true;
      checkboxAutoWebhook.checked = false;
      labelAutoWebhook.style.opacity = '0.5';
      if (!hasWebhookUrl) {
        labelAutoWebhook.innerText = 'AI 整理完成後自動傳送 Webhook (需填寫 Webhook URL)';
      } else {
        labelAutoWebhook.innerText = 'AI 整理完成後自動傳送 Webhook (需開啟自動 AI 整理)';
      }
    }

    // Enable/disable manual webhook button on workspace footer
    if (btnWebhook) {
      btnWebhook.disabled = !hasWebhookUrl;
      btnWebhook.title = hasWebhookUrl ? '傳送至 Webhook' : '請先在設定中填寫 Webhook URL';
    }
  };

  // Add event listeners to trigger UI updates
  inputWebhookUrl.addEventListener('input', updateWebhookSettingsUI);
  checkboxAutoSummarize.addEventListener('change', updateWebhookSettingsUI);

  // --- Load Settings ---
  const loadSettings = async () => {
    return new Promise((resolve) => {
      chrome.storage.local.get(['settings'], (result) => {
        const defaultSettings = {
          geminiApiKey: '',
          targetEmail: '',
          webhookUrl: '',
          downloadFolder: 'auto-meeting-minutes',
          autoDownloadOnEnd: true,
          autoSummarize: false,
          autoWebhook: false,
          autoEnableCC: true,
          summaryModel: 'gemini-3.5-flash',
          promptTemplate: '你是一位專業的會議記錄秘書。請協助我整理會議逐字稿。請務必遵守以下輸出格式，將內容分為兩個區塊，並使用 === [標題] === 包裝：\n\n=== [會議紀錄] ===\n- 會議主旨：[會議主旨名稱]\n- 會議摘要與決議事項：\n  ...（請在此處輸出整理好的條列式會議精要）\n- 待辦事項與指派對象（若有）\n\n=== [優化逐字稿] ===\n（請在此處將輸入的每一句對話，修正其語音辨識錯誤、同音異字並消除贅字，依照發言順序輸出，每行格式固定為：\n[時間 - 說話者]: 優化後的對話內容）'
        };
        globalSettings = { ...defaultSettings, ...result.settings };

        // Backwards compatibility migration
        if (result.settings && result.settings.autoSummarizeAndWebhook !== undefined) {
          globalSettings.autoSummarize = result.settings.autoSummarizeAndWebhook;
          globalSettings.autoWebhook = result.settings.autoSummarizeAndWebhook;
        }

        // Populate Form Fields
        inputGeminiKey.value = globalSettings.geminiApiKey || '';
        selectGeminiModel.value = globalSettings.summaryModel || 'gemini-3.5-flash';
        inputTargetEmail.value = globalSettings.targetEmail || '';
        inputWebhookUrl.value = globalSettings.webhookUrl || '';
        inputDownloadFolder.value = globalSettings.downloadFolder || 'auto-meeting-minutes';
        checkboxAutoDownload.checked = !!globalSettings.autoDownloadOnEnd;
        checkboxAutoSummarize.checked = !!globalSettings.autoSummarize;
        checkboxAutoWebhook.checked = !!globalSettings.autoWebhook;
        checkboxAutoEnableCC.checked = globalSettings.autoEnableCC !== undefined ? !!globalSettings.autoEnableCC : true;
        textareaPromptTemplate.value = globalSettings.promptTemplate || '';

        // Update UI states
        updateWebhookSettingsUI();

        resolve(globalSettings);
      });
    });
  };

  // --- Save Settings ---
  btnSaveSettings.addEventListener('click', () => {
    const newSettings = {
      geminiApiKey: inputGeminiKey.value.trim(),
      summaryModel: selectGeminiModel.value,
      targetEmail: inputTargetEmail.value.trim(),
      webhookUrl: inputWebhookUrl.value.trim(),
      downloadFolder: inputDownloadFolder.value.trim().replace(/\/$/, ''),
      autoDownloadOnEnd: checkboxAutoDownload.checked,
      autoSummarize: checkboxAutoSummarize.checked,
      autoWebhook: checkboxAutoWebhook.checked,
      autoEnableCC: checkboxAutoEnableCC.checked,
      promptTemplate: textareaPromptTemplate.value
    };

    chrome.storage.local.set({ settings: newSettings }, () => {
      globalSettings = newSettings;
      saveStatus.classList.add('show');
      setTimeout(() => {
        saveStatus.classList.remove('show');
      }, 2000);
      console.log("[Popup] Settings saved:", newSettings);
    });
  });

  // --- Clear History ---
  const btnClearHistory = document.getElementById('btn-clear-history');
  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', () => {
      if (confirm('您確定要清除所有的歷史會議紀錄嗎？\n\n⚠️ 注意：一旦清除，所有的會議紀錄將會永遠消失且「無法復原」！')) {
        chrome.storage.local.set({ history: [] }, () => {
          alert('已成功清除所有歷史會議紀錄！');
          selectedMeeting = null;
          workspaceFooter.style.display = 'none';
          aiPlaceholderMsg.style.display = 'none';
          summaryContent.style.display = 'none';
          btnCopyRaw.style.display = 'none';
          btnDownloadRaw.style.display = 'none';
          selectedTitle.innerText = '請從左側選擇會議或開始錄製';
          selectedDate.innerText = '';
          loadHistoryList();
        });
      }
    });
  }

  // --- Active Recording Sync & Polling ---
  const updateActiveRecordingTab = (session) => {
    if (!session) {
      // Not in a meeting or no active session
      statusDot.className = 'indicator-dot gray-dot';
      statusText.innerText = '未在會議中';
      headerPulse.className = 'pulse-dot';
      meetingTitle.innerText = '未在偵測到 Google Meet';
      meetingUrl.innerText = '請開啟 Google Meet 並加入會議';
      lineCount.innerText = '0';
      wordCount.innerText = '0';
      recordTime.innerText = '00:00';
      liveTranscript.innerHTML = '<p class="placeholder-text">請在 Google Meet 中點擊下方「CC」字幕按鈕以啟動擷取。</p>';
      btnToggleCapture.disabled = true;
      btnEndMeeting.disabled = true;
      return;
    }

    btnToggleCapture.disabled = false;
    btnEndMeeting.disabled = false;

    // Pulse dot states
    if (session.isCapturing && session.isObserving) {
      statusDot.className = 'indicator-dot red-pulse';
      statusText.innerText = '正在擷取 CC 字幕';
      headerPulse.className = 'pulse-dot recording';
      btnToggleCapture.innerText = '暫停錄製';
      btnToggleCapture.className = 'btn btn-secondary';
    } else if (!session.isCapturing) {
      statusDot.className = 'indicator-dot yellow-dot';
      statusText.innerText = '錄製已暫停';
      headerPulse.className = 'pulse-dot active';
      btnToggleCapture.innerText = '繼續錄製';
      btnToggleCapture.className = 'btn btn-primary';
    } else {
      statusDot.className = 'indicator-dot yellow-dot';
      statusText.innerText = '等待 CC 啟動';
      headerPulse.className = 'pulse-dot active';
      btnToggleCapture.innerText = '暫停錄製';
      btnToggleCapture.className = 'btn btn-secondary';
    }

    meetingTitle.innerText = session.title || 'Google Meet Meeting';
    meetingUrl.innerText = session.url || '';

    // Calculate metrics
    const transcript = session.transcript || [];
    lineCount.innerText = transcript.length;
    
    let words = 0;
    transcript.forEach(seg => {
      words += (seg.text.match(/\S+/g) || []).length;
    });
    wordCount.innerText = words;

    // Calculate duration
    const diffMs = Date.now() - session.startTime;
    const diffMins = Math.floor(diffMs / 60000);
    const diffSecs = Math.floor((diffMs % 60000) / 1000);
    recordTime.innerText = `${diffMins.toString().padStart(2, '0')}:${diffSecs.toString().padStart(2, '0')}`;

    // Render Preview
    if (transcript.length === 0) {
      liveTranscript.innerHTML = '<p class="placeholder-text">等待 Google Meet CC 字幕產生中...<br>(請確認會議網頁已點擊「CC」開啟字幕)</p>';
    } else {
      let html = '';
      // Show the last 15 lines of transcript
      const recentLines = transcript.slice(-15);
      recentLines.forEach(seg => {
        html += `
          <div class="preview-line">
            <span class="preview-speaker">${escapeHtml(seg.speaker)}</span>: 
            <span>${escapeHtml(seg.text)}</span>
          </div>
        `;
      });
      liveTranscript.innerHTML = html;
      // Scroll to bottom
      liveTranscript.scrollTop = liveTranscript.scrollHeight;
    }
  };

  const startActiveRecordingPolling = () => {
    if (activePollingInterval) clearInterval(activePollingInterval);
    
    // Initial fetch
    chrome.runtime.sendMessage({ type: 'GET_ACTIVE_SESSION' }, (response) => {
      updateActiveRecordingTab(response?.activeSession);
    });

    // Poll every 1s
    activePollingInterval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_SESSION' }, (response) => {
        updateActiveRecordingTab(response?.activeSession);
      });
    }, 1000);
  };

  const stopActiveRecordingPolling = () => {
    if (activePollingInterval) {
      clearInterval(activePollingInterval);
      activePollingInterval = null;
    }
  };

  // Toggle active recording state from popup
  btnToggleCapture.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVE_SESSION' }, (response) => {
      const session = response?.activeSession;
      if (session && session.tabId) {
        // Send toggle command directly to tab's content script
        chrome.tabs.sendMessage(session.tabId, { type: 'FORCE_TOGGLE_CAPTURE' }, (res) => {
          if (chrome.runtime.lastError) {
            console.error("Could not communicate with content script:", chrome.runtime.lastError);
          } else {
            console.log("Toggle capture response:", res);
          }
        });
      }
    });
  });

  // End meeting manually
  btnEndMeeting.addEventListener('click', () => {
    if (confirm('確定要結束目前會議的錄製，並整理會議紀錄嗎？')) {
      chrome.runtime.sendMessage({ type: 'FORCE_FINALIZE_MEETING' }, (response) => {
        if (response && response.status === 'finalized') {
          // Switch to History & AI tab and select the finalized session
          switchTab('history-ai');
          setTimeout(() => {
            selectMeetingSession(response.session);
            loadHistoryList();
          }, 300);
        } else {
          alert('無法結束錄製：當前沒有活動的會議，或是錄製內容為空。');
        }
      });
    }
  });

  // --- History list and AI Summarizer ---
  const loadHistoryList = () => {
    chrome.storage.local.get(['history', 'autoProcessingSessions'], (result) => {
      const history = result.history || [];
      const processingMap = result.autoProcessingSessions || {};
      
      if (history.length === 0) {
        historyListContainer.innerHTML = '<p class="placeholder-text">尚無歷史會議紀錄</p>';
        return;
      }

      let html = '';
      history.forEach((session, index) => {
        const dateStr = new Date(session.startTime).toLocaleDateString('zh-TW', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        const activeClass = selectedMeeting && selectedMeeting.id === session.id ? 'active' : '';
        const isProcessing = !!processingMap[session.id];
        
        html += `
          <div class="history-item ${activeClass}" data-id="${session.id}">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <h4 style="margin: 0; max-width: ${isProcessing ? '120px' : '100%'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(session.title)}</h4>
              ${isProcessing ? '<span class="ai-processing-badge">AI 整理中...</span>' : ''}
            </div>
            <div class="history-meta" style="margin-top: 4px;">
              <span>${dateStr}</span>
              <span>${session.transcript ? session.transcript.length : 0} 句</span>
            </div>
          </div>
        `;
      });
      historyListContainer.innerHTML = html;

      // Add click handlers
      const items = historyListContainer.querySelectorAll('.history-item');
      items.forEach(item => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          const session = history.find(s => s.id === id);
          if (session) {
            selectMeetingSession(session);
            // Highlight active item
            items.forEach(el => el.classList.remove('active'));
            item.classList.add('active');
          }
        });
      });
    });
  };

  const selectMeetingSession = (session) => {
    selectedMeeting = session;
    selectedTitle.innerText = session.title;
    const dateStr = new Date(session.startTime).toLocaleString('zh-TW');
    selectedDate.innerText = `會議時間：${dateStr} | 共 ${session.transcript ? session.transcript.length : 0} 句字幕`;
    
    // Show copy and download raw transcript buttons
    btnCopyRaw.style.display = 'inline-block';
    btnDownloadRaw.style.display = 'inline-block';
    
    // Show footer workspace panel
    workspaceFooter.style.display = 'block';

    // Check if currently auto-processing
    chrome.storage.local.get(['autoProcessingSessions'], (result) => {
      const processingMap = result.autoProcessingSessions || {};
      const processingState = processingMap[session.id];
      
      // If we are currently auto-processing
      if (processingState) {
        aiPlaceholderMsg.style.display = 'none';
        summaryContent.style.display = 'block';
        
        let statusText = 'Gemini 正在背景整理會議紀錄，請稍候...';
        if (processingState.status === 'webhook') {
          statusText = '會議紀錄整理完成，正在傳送 Webhook 郵件，請稍候...';
        }
        
        summaryContent.innerHTML = `
          <div class="ai-processing-workspace-container">
            <div class="pulse-spinner"></div>
            <div style="font-weight: 600; color: #8b5cf6;">背景自動處理中</div>
            <div style="font-size: 13px; color: var(--text-muted);">${statusText}</div>
          </div>
        `;
        
        btnRunAi.disabled = true;
        btnRunAi.innerHTML = `
          背景自動處理中...
        `;
        exportActionsRow.style.display = 'none';
        return;
      }
      
      // Otherwise, normal state
      btnRunAi.disabled = false;
      
      // Renders existing summary or prompts to generate
      if (session.summary) {
        aiPlaceholderMsg.style.display = 'none';
        summaryContent.style.display = 'block';
        summaryContent.innerHTML = parseMarkdown(session.summary);
        btnRunAi.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L4.7 18.7c-1.07-1.78-1.7-3.87-1.7-6.7 0-6.07 4.93-11 11-11zm8 8c0 1.57-.46 3.03-1.24 4.26l1.46 1.46c1.07-1.78 1.7-3.87 1.7-6.7 0-6.07-4.93-11-11-11v3l-4-4 4-4v3c4.42 0 8 3.58 8 8z"/>
          </svg>
          重新整理會議紀錄
        `;
        exportActionsRow.style.display = 'grid';
      } else {
        aiPlaceholderMsg.style.display = 'flex';
        summaryContent.style.display = 'none';
        btnRunAi.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"/>
          </svg>
          Gemini 一鍵整理會議紀錄
        `;
        exportActionsRow.style.display = 'none';
      }
    });
  };

  // Download raw transcript file from history
  btnDownloadRaw.addEventListener('click', () => {
    if (selectedMeeting) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_SESSION',
        session: selectedMeeting
      });
    }
  });

  // Call Gemini API to summarize
  btnRunAi.addEventListener('click', async () => {
    if (!selectedMeeting) return;
    
    const apiKey = globalSettings.geminiApiKey;
    if (!apiKey) {
      alert('請先在「設定」分頁中填寫您的 Gemini API Key！');
      switchTab('settings');
      return;
    }

    // Show Loading state
    summaryContent.style.display = 'none';
    aiPlaceholderMsg.style.display = 'none';
    
    const loader = document.createElement('div');
    loader.className = 'spinner-container';
    loader.id = 'ai-loader';
    loader.innerHTML = `
      <div class="spinner"></div>
      <span class="loading-text">Gemini 正在整理會議紀錄，請稍候...</span>
    `;
    summaryResultBox.appendChild(loader);
    btnRunAi.disabled = true;

    try {
      // Build transcript text representation
      let transcriptText = "";
      if (!selectedMeeting.transcript || selectedMeeting.transcript.length === 0) {
        transcriptText = "(空白逐字稿)";
      } else {
        selectedMeeting.transcript.forEach(seg => {
          transcriptText += `[${seg.speaker} - ${seg.timestamp}]: ${seg.text}\n`;
        });
      }

      // Populate Prompt Template
      let finalPrompt = globalSettings.promptTemplate || '';
      if (finalPrompt.includes('{{TRANSCRIPT}}')) {
        finalPrompt = finalPrompt.replace('{{TRANSCRIPT}}', transcriptText);
      } else {
        finalPrompt = `${finalPrompt}\n\n[會議逐字稿]\n${transcriptText}`;
      }
      const model = globalSettings.summaryModel || 'gemini-1.5-flash';

      // Call Google Gemini API via native Fetch
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText) {
        throw new Error("API 回傳結構中找不到產生的文字內容。");
      }

      // Parse output: split by "=== [優化逐字稿] ==="
      let summaryText = generatedText;
      let optimizedTranscript = "";

      const splitTokens = ['=== [優化逐字稿] ===', '===[優化逐字稿]===', '優化逐字稿', '=== [優化對話] ===', '=== [優化逐字稿]'];
      for (const token of splitTokens) {
        if (generatedText.includes(token)) {
          const parts = generatedText.split(token);
          summaryText = parts[0].replace('=== [會議紀錄] ===', '').replace('=== [會議記錄] ===', '').trim();
          optimizedTranscript = parts[1].trim();
          break;
        }
      }

      // Save in state object
      selectedMeeting.summary = summaryText;
      selectedMeeting.optimizedTranscript = optimizedTranscript;
      
      // Update history in chrome storage
      chrome.storage.local.get(['history'], (res) => {
        const history = res.history || [];
        const index = history.findIndex(s => s.id === selectedMeeting.id);
        if (index !== -1) {
          history[index].summary = summaryText;
          history[index].optimizedTranscript = optimizedTranscript;
          chrome.storage.local.set({ history: history });
        }
      });

      // Render summary
      document.getElementById('ai-loader')?.remove();
      summaryContent.style.display = 'block';
      summaryContent.innerHTML = parseMarkdown(summaryText);
      exportActionsRow.style.display = 'grid';
      
      // Update button text to "Re-run"
      btnRunAi.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L4.7 18.7c-1.07-1.78-1.7-3.87-1.7-6.7 0-6.07 4.93-11 11-11zm8 8c0 1.57-.46 3.03-1.24 4.26l1.46 1.46c1.07-1.78 1.7-3.87 1.7-6.7 0-6.07-4.93-11-11-11v3l-4-4 4-4v3c4.42 0 8 3.58 8 8z"/>
        </svg>
        重新整理會議紀錄
      `;

    } catch (error) {
      console.error("[Popup AI Error]:", error);
      document.getElementById('ai-loader')?.remove();
      aiPlaceholderMsg.style.display = 'flex';
      aiPlaceholderMsg.innerHTML = `
        <svg viewBox="0 0 24 24" width="48" height="48" fill="#ef4444">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 12 10 12 10-4.48 10-12S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <p style="color:#f87171;">AI 會議紀錄整理失敗。<br>錯誤資訊: ${error.message}</p>
      `;
    } finally {
      btnRunAi.disabled = false;
    }
  });

  // Export - Email (mailto)
  btnEmail.addEventListener('click', () => {
    if (!selectedMeeting || !selectedMeeting.summary) return;
    const targetEmail = globalSettings.targetEmail || '';
    
    // Extract actual subject from AI summary, fallback to meeting title
    const aiSubject = extractSubjectFromSummary(selectedMeeting.summary, selectedMeeting.title);
    const subject = encodeURIComponent(`【自動會議紀錄】${aiSubject}`);
    
    // Convert summary markdown to clean plain text for email
    const cleanSummary = convertMarkdownToPlainText(selectedMeeting.summary);
    
    // Construct rich email body
    const dateStr = new Date(selectedMeeting.startTime).toLocaleString('zh-TW');
    let emailBody = `會議主題：${selectedMeeting.title}\n會議時間：${dateStr}\n會議連結：${selectedMeeting.url}\n\n=======================\n會議摘要與紀要：\n\n${cleanSummary}`;
    const body = encodeURIComponent(emailBody);
    
    const mailtoUrl = `mailto:${targetEmail}?subject=${subject}&body=${body}`;
    
    // Open system mail client
    window.open(mailtoUrl, '_blank');
  });

  // Export - Webhook
  btnWebhook.addEventListener('click', async () => {
    if (!selectedMeeting || !selectedMeeting.summary) return;
    const webhookUrl = globalSettings.webhookUrl;
    if (!webhookUrl) {
      alert('請先在「設定」分頁中填寫您的 Webhook URL！');
      switchTab('settings');
      return;
    }

    btnWebhook.disabled = true;
    btnWebhook.innerText = '傳送中...';

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain'
        },
        body: JSON.stringify({
          id: selectedMeeting.id,
          title: selectedMeeting.title,
          url: selectedMeeting.url,
          startTime: selectedMeeting.startTime,
          startTimeStr: new Date(selectedMeeting.startTime).toISOString(),
          summary: selectedMeeting.summary,
          summaryPlainText: convertMarkdownToPlainText(selectedMeeting.summary),
          summaryHtml: parseMarkdownToHtml(selectedMeeting.summary),
          aiSubject: extractSubjectFromSummary(selectedMeeting.summary, selectedMeeting.title),
          transcript: selectedMeeting.transcript,
          targetEmail: globalSettings.targetEmail
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP 錯誤狀態碼: ${response.status}`);
      }

      alert('會議紀錄已成功傳送至指定的 Webhook！');
    } catch (error) {
      console.error("[Popup Webhook Error]:", error);
      alert(`Webhook 傳送失敗。\n${error.message}`);
    } finally {
      btnWebhook.disabled = false;
      btnWebhook.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-2 14H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V8h12v2z"/>
        </svg>
        Webhook 發送
      `;
    }
  });

  // Export - Copy to Clipboard
  btnCopy.addEventListener('click', () => {
    if (!selectedMeeting || !selectedMeeting.summary) return;
    
    const textToCopy = `主題: ${selectedMeeting.title}\n時間: ${new Date(selectedMeeting.startTime).toLocaleString()}\n連結: ${selectedMeeting.url}\n\n會議紀錄整理:\n${selectedMeeting.summary}`;
    
    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalText = btnCopy.innerText;
      btnCopy.innerText = '已複製！';
      setTimeout(() => {
        btnCopy.innerText = originalText;
      }, 1500);
    }).catch(err => {
      console.error('Copy failed:', err);
      alert('複製失敗，請手動選取文字複製。');
    });
  });

  // Export - Download HTML File
  btnDownloadHtml.addEventListener('click', () => {
    if (!selectedMeeting) return;

    const date = new Date(selectedMeeting.startTime);
    const dateSlug = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
    const cleanTitle = selectedMeeting.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 30);
    
    const folder = globalSettings.downloadFolder ? globalSettings.downloadFolder.trim().replace(/\/$/, '') : 'auto-meeting-minutes';
    const filename = `${folder}/meeting_${dateSlug}_${cleanTitle}_summary.html`;

    const htmlContent = formatTranscriptAsHtml(selectedMeeting);
    const base64Data = btoa(unescape(encodeURIComponent(htmlContent)));
    const dataUrl = `data:text/html;base64,${base64Data}`;

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: true // Let user save or select directory path
    });
  });

  // Export - Copy Raw Transcript to Clipboard
  btnCopyRaw.addEventListener('click', () => {
    if (!selectedMeeting || !selectedMeeting.transcript || selectedMeeting.transcript.length === 0) {
      alert('逐字稿內容為空，無法複製。');
      return;
    }
    
    let rawText = "";
    selectedMeeting.transcript.forEach(seg => {
      rawText += `[${seg.speaker} - ${seg.timestamp}]: ${seg.text}\n`;
    });
    
    navigator.clipboard.writeText(rawText).then(() => {
      const originalText = btnCopyRaw.innerText;
      btnCopyRaw.innerText = '已複製！';
      setTimeout(() => {
        btnCopyRaw.innerText = originalText;
      }, 1500);
    }).catch(err => {
      console.error('Copy raw failed:', err);
      alert('複製失敗，請重試。');
    });
  });

  // Export - Download Raw Transcript File
  btnDownloadRaw.addEventListener('click', () => {
    if (!selectedMeeting || !selectedMeeting.transcript || selectedMeeting.transcript.length === 0) {
      alert('逐字稿內容為空，無法下載。');
      return;
    }
    
    let rawText = `# 會議原始逐字稿: ${selectedMeeting.title}\n`;
    rawText += `會議時間: ${new Date(selectedMeeting.startTime).toLocaleString('zh-TW')}\n`;
    rawText += `會議連結: ${selectedMeeting.url}\n\n=======================\n\n`;
    
    selectedMeeting.transcript.forEach(seg => {
      rawText += `**${seg.speaker}** (${seg.timestamp}):\n${seg.text}\n\n`;
    });
    
    const date = new Date(selectedMeeting.startTime);
    const dateSlug = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
    const cleanTitle = selectedMeeting.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 30);
    
    const folder = globalSettings.downloadFolder ? globalSettings.downloadFolder.trim().replace(/\/$/, '') : 'auto-meeting-minutes';
    const filename = `${folder}/meeting_${dateSlug}_${cleanTitle}_raw.txt`;
    
    const base64Data = btoa(unescape(encodeURIComponent(rawText)));
    const dataUrl = `data:text/plain;base64,${base64Data}`;
    
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: true
    });
  });

  // --- Helper Functions ---
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

  // --- Helper Functions ---
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

  // Basic Markdown to HTML parser
  const parseMarkdown = (markdown) => {
    if (!markdown) return '';
    
    let html = markdown;
    
    // Headers (H6 down to H1)
    html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
    html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
    html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
    
    // Code blocks (inline)
    html = html.replace(/`(.*?)`/gim, '<code>$1</code>');
    
    // Lists
    html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/^\s*\*\s+(.*$)/gim, '<li>$1</li>');
    
    // Wrap consecutive list items in <ul>
    // Note: This is a very simplified markdown parser.
    html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/gim, ''); // Combine adjacent list blocks
    
    // Newlines to paragraphs
    html = html.split('\n\n').map(para => {
      // Check if it's already a block tag (like <h2>, <ul>, etc.)
      if (para.trim().startsWith('<h') || para.trim().startsWith('<ul') || para.trim().startsWith('<li')) {
        return para;
      }
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    
    return html;
  };

  // --- Init ---
  const initPopup = async () => {
    await loadSettings();
    switchTab('active-recording');

    // Dynamically react to background process updates
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.history || changes.autoProcessingSessions) {
          console.log("[Popup] Storage changed, reloading history and selection...");
          loadHistoryList();
          
          if (selectedMeeting) {
            chrome.storage.local.get(['history'], (result) => {
              const history = result.history || [];
              const updated = history.find(s => s.id === selectedMeeting.id);
              if (updated) {
                // Refresh selection display to reflect progress or loaded summary
                selectMeetingSession(updated);
              }
            });
          }
        }
      }
    });
  };

  initPopup();
});
