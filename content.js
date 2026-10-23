/**
 * Auto Meeting Minutes - Content Script
 * Captures Closed Captions (CC) in real-time from Google Meet.
 */

(function () {
  // Only inject in valid Google Meet meetings
  const isMeetingPage = () => {
    const path = window.location.pathname.substring(1);
    // Support both /abc-defg-hij and /meet/abc-defg-hij meeting URLs.
    const meetCodeRegex = /^(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;
    return meetCodeRegex.test(path);
  };

  if (!isMeetingPage()) {
    console.log("[Meet CC Capturer] Not a meeting landing page. Content script idle.");
    return;
  }

  console.log("[Meet CC Capturer] Content script initialized on meeting page.");

  // State Variables
  let isCapturing = true;
  let isObserving = false;
  let captionsContainer = null;
  let mutationObserver = null;
  let checkInterval = null;
  let hasAutoEnabled = false;
  
  // Maps DOM elements of speaker blocks to transcript segment objects
  const activeBlocks = new Map();
  // Array of all finalized and active transcript segments
  let transcript = [];

  // DOM Elements for Overlay
  let overlayEl = null;
  let indicatorEl = null;
  let countEl = null;
  let textEl = null;
  let recordBtn = null;

  // Recording State variables
  let recordingElapsedSeconds = 0;
  let isRecording = false;
  let recordingMode = 'none';
  let uploadState = null;
  let uploadError = null;

  // UUID Generator for segments
  const generateUUID = () => {
    return 'seg_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  };

  // Safe messaging wrapper to avoid context invalidated errors when extension is updated/reloaded
  const safeSendMessage = (msg, callback) => {
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            // Ignore runtime errors from context invalidation during callback
          } else if (callback) {
            callback(res);
          }
        });
      }
    } catch (err) {
      // Catch context invalidation exceptions silently
    }
  };

  // Clamp the overlay element position to stay fully within screen boundaries
  const clampPosition = () => {
    if (!overlayEl) return;
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const margin = 16;

    const rect = overlayEl.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    const width = rect.width;
    const height = rect.height;

    if (left < margin) {
      left = margin;
    } else if (left + width > screenWidth - margin) {
      left = screenWidth - width - margin;
    }

    if (top < margin) {
      top = margin;
    } else if (top + height > screenHeight - margin) {
      top = screenHeight - height - margin;
    }

    overlayEl.style.left = `${left}px`;
    overlayEl.style.top = `${top}px`;
    overlayEl.style.right = 'auto';
  };

  // Create and inject the floating overlay status pill
  const injectOverlay = () => {
    if (document.getElementById('meet-cc-overlay')) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'meet-cc-overlay';
    overlayEl.className = 'meet-cc-overlay';

    indicatorEl = document.createElement('div');
    indicatorEl.className = 'meet-cc-indicator capturing';

    textEl = document.createElement('span');
    textEl.className = 'meet-cc-text';
    textEl.innerText = 'CC Capturer: Waiting';

    countEl = document.createElement('span');
    countEl.className = 'meet-cc-count';
    countEl.innerText = '0';
    countEl.style.display = 'none';

    // Pause/Resume Button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'meet-cc-btn';
    toggleBtn.title = 'Pause / Resume';
    toggleBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 12 10 12 10-4.48 10-12S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
      </svg>
    `;
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCapture();
    });

    // Record / Stop Audio-Video button
    recordBtn = document.createElement('button');
    recordBtn.className = 'meet-cc-btn';
    recordBtn.title = '開始錄音/錄影';
    recordBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" style="color: #94a3b8;">
        <circle cx="12" cy="12" r="8"/>
      </svg>
    `;
    recordBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleManualRecording();
    });

    // Minimize Button
    const minBtn = document.createElement('button');
    minBtn.className = 'meet-cc-btn';
    minBtn.title = 'Minimize / Maximize';
    minBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 13H5v-2h14v2z"/>
      </svg>
    `;

    const toggleMinimize = (e) => {
      if (e) e.stopPropagation();
      
      // Record center coordinate before toggle
      const rectBefore = overlayEl.getBoundingClientRect();
      const centerX = rectBefore.left + rectBefore.width / 2;
      const centerY = rectBefore.top + rectBefore.height / 2;

      overlayEl.classList.toggle('minimized');
      if (overlayEl.classList.contains('minimized')) {
        minBtn.title = 'Maximize';
        minBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 12 10 12 10-4.48 10-12S17.52 2 12 2zm1 11h3v2h-3v3h-2v-3H8v-2h3V8h2v5z"/></svg>`;
      } else {
        minBtn.title = 'Minimize';
        minBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>`;
      }

      // Re-position based on center coordinates and clamp
      setTimeout(() => {
        const rectAfter = overlayEl.getBoundingClientRect();
        let newLeft = centerX - rectAfter.width / 2;
        let newTop = centerY - rectAfter.height / 2;
        
        overlayEl.style.left = `${newLeft}px`;
        overlayEl.style.top = `${newTop}px`;
        overlayEl.style.right = 'auto';
        
        clampPosition();
      }, 0);
    };

    minBtn.addEventListener('click', toggleMinimize);

    overlayEl.appendChild(indicatorEl);
    overlayEl.appendChild(textEl);
    overlayEl.appendChild(countEl);
    overlayEl.appendChild(toggleBtn);
    overlayEl.appendChild(recordBtn);
    overlayEl.appendChild(minBtn);

    // Make the pill draggable (basic implementation)
    let isDragging = false;
    let offsetX, offsetY;

    overlayEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.meet-cc-btn')) return; // Don't drag when clicking buttons
      isDragging = true;
      offsetX = e.clientX - overlayEl.offsetLeft;
      offsetY = e.clientY - overlayEl.offsetTop;
      overlayEl.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;
      const margin = 16;
      
      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;
      const rect = overlayEl.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      
      if (left < margin) left = margin;
      if (left + width > screenWidth - margin) left = screenWidth - width - margin;
      if (top < margin) top = margin;
      if (top + height > screenHeight - margin) top = screenHeight - height - margin;

      overlayEl.style.left = `${left}px`;
      overlayEl.style.top = `${top}px`;
      overlayEl.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (overlayEl) overlayEl.style.cursor = 'grab';
    });

    // Double-click anywhere on the pill (except buttons) to minimize/maximize
    overlayEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.meet-cc-btn')) return; // Don't toggle on button double-clicks
      toggleMinimize(e);
    });

    overlayEl.style.cursor = 'grab';
    document.body.appendChild(overlayEl);
  };

  // Update Status UI
  const updateUI = () => {
    if (!overlayEl) return;

    let baseText = 'CC Capturer: Waiting for CC';
    if (!isCapturing) {
      indicatorEl.className = 'meet-cc-indicator paused';
      baseText = 'CC Capturer: Paused';
    } else if (isObserving) {
      indicatorEl.className = 'meet-cc-indicator capturing';
      baseText = 'CC Capturer: Active';
    } else {
      indicatorEl.className = 'meet-cc-indicator paused';
      baseText = 'CC Capturer: Waiting for CC';
    }

    // Append recording or upload status to baseText if active
    if (uploadState === 'uploading') {
      baseText += ` | 📤 正在上傳音檔...`;
    } else if (uploadState === 'success') {
      baseText += ` | 📤 音檔上傳成功！`;
    } else if (uploadState === 'failed') {
      baseText += ` | ❌ 上傳失敗: ${uploadError || '未知錯誤'}`;
    } else if (isRecording && recordingElapsedSeconds > 0) {
      const minutes = String(Math.floor(recordingElapsedSeconds / 60)).padStart(2, '0');
      const seconds = String(recordingElapsedSeconds % 60).padStart(2, '0');
      const recType = recordingMode === 'video' ? '影音' : '語音';
      baseText += ` | 🔴 ${recType}錄影中 ${minutes}:${seconds}`;
    }

    textEl.innerText = baseText;
    countEl.innerText = transcript.length;
    countEl.style.display = (isCapturing && isObserving && transcript.length > 0) || (!isCapturing && transcript.length > 0) ? 'inline-block' : 'none';

    // Update Record Button state
    if (recordBtn) {
      if (isRecording) {
        recordBtn.title = '停止錄音/錄影並儲存';
        recordBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="currentColor" class="recording-active" style="color: #ef4444;">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        `;
      } else {
        const recTitle = recordingMode === 'video' ? '影音' : '聲音';
        recordBtn.title = `開始錄製會議${recTitle}`;
        recordBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="currentColor" style="color: #94a3b8;">
            <circle cx="12" cy="12" r="8"/>
          </svg>
        `;
      }
    }
  };

  // Handle resetting baselines for active blocks on resume
  const handleResumeCapturing = () => {
    const container = findCaptionsContainer();
    if (!container) return;

    Array.from(container.children).forEach(block => {
      let speaker = 'Speaker';
      let text = '';
      const speakerEl = block.querySelector('.NWpY1d');
      const textEl = block.querySelector('.ygicle.VbkSUe') || block.querySelector('.iTTPOb');
      if (speakerEl && textEl) {
        speaker = speakerEl.innerText.trim();
        text = textEl.innerText.trim();
      } else if (block.children && block.children.length >= 2) {
        speaker = block.children[0].innerText.trim();
        text = block.children[1].innerText.trim();
      } else {
        text = (block.innerText || '').trim();
      }
      text = text.replace(/\s+/g, ' ').trim();

      activeBlocks.set(block, {
        id: generateUUID(),
        speaker: speaker,
        text: '', // Start fresh for post-resume speech
        timestamp: new Date().toLocaleTimeString(),
        baselineText: text,
        isPlaceholder: true // Flag indicating it is a baseline placeholder
      });
    });
    console.log("[Meet CC Capturer] Resumed capturing. Established new baselines for active blocks.");
  };

  // Toggle capturing state
  const toggleCapture = () => {
    isCapturing = !isCapturing;
    console.log(`[Meet CC Capturer] Capture state toggled to: ${isCapturing}`);
    
    if (isCapturing) {
      handleResumeCapturing();
    }
    
    // Notify background script of state change
    safeSendMessage({
      type: 'SET_CAPTURE_STATE',
      isCapturing: isCapturing
    });

    updateUI();
  };

  // Toggle manual audio/video recording via user gesture click on the overlay
  const toggleManualRecording = () => {
    if (isRecording) {
      // Stopping recording does not require activeTab permission, so it's always allowed from webpage
      safeSendMessage({ type: 'TOGGLE_MANUAL_RECORDING' }, (res) => {
        console.log("[Content] Stopped recording response:", res);
      });
    } else {
      // Guide the user to start recording from the extension popup
      if (textEl) {
        const originalText = textEl.innerText;
        textEl.innerText = "⚠️ 請點右上角外掛圖示，在面板中點『🔴 啟動錄製』來錄音";
        textEl.style.color = "#fbbf24"; // Amber warning color
        
        setTimeout(() => {
          if (textEl) {
            textEl.style.color = "";
            updateUI();
          }
        }, 5000);
      }
    }
  };

  // Find captions container inside Google Meet
  const findCaptionsContainer = () => {
    // Standard selectors for Google Meet CC region
    const selectors = [
      '[role="region"][aria-label*="Captions" i]',
      '[role="region"][aria-label*="자막"]',
      '[role="region"][aria-label*="subtitle" i]',
      '[role="region"][aria-label*="字幕"]',
      '[role="region"][aria-label*="會議字幕"]',
      '[jsname="dsyhDe"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      // Ensure it is not our own overlay
      if (el && !el.closest('#meet-cc-overlay')) {
        return el;
      }
    }
    return null;
  };

  // Process mutations in the captions container
  const handleMutations = (mutations) => {
    if (!isCapturing) return;

    let hasUpdates = false;

    // Get direct children of captions container (each representing a speaker turn block)
    const blocks = Array.from(captionsContainer.children);

    blocks.forEach((block) => {
      // Ignore non-element nodes or elements that are part of controls
      if (block.nodeType !== Node.ELEMENT_NODE) return;
      if (block.classList.contains('meet-cc-btn') || block.id === 'meet-cc-overlay') return;

      // Extract speaker name and text content using class selectors and structural DOM fallbacks
      let speaker = 'Speaker';
      let text = '';

      const speakerEl = block.querySelector('.NWpY1d');
      const textEl = block.querySelector('.ygicle.VbkSUe') || block.querySelector('.iTTPOb');

      if (speakerEl && textEl) {
        speaker = speakerEl.innerText.trim();
        text = textEl.innerText.trim();
      } else if (block.children && block.children.length >= 2) {
        // Fallback: Use structural children (Child 0 is speaker name container, Child 1 is text container)
        speaker = block.children[0].innerText.trim();
        text = block.children[1].innerText.trim();
      } else {
        // Fallback: Read whole block text and extract speaker if possible
        const blockText = (block.innerText || '').trim();
        const firstSpan = block.querySelector('span');
        if (firstSpan) {
          const firstSpanText = firstSpan.innerText.trim();
          if (firstSpanText && firstSpanText !== blockText) {
            speaker = firstSpanText;
            text = blockText.replace(speaker, '').trim();
          } else {
            speaker = 'Speaker';
            text = blockText;
          }
        } else {
          speaker = 'Speaker';
          text = blockText;
        }
      }

      // Clean up whitespace and newlines from text
      text = text.replace(/\s+/g, ' ').trim();

      // Ignore trivial or empty text
      if (!text || text.length < 2) return;

      // Update or create segment
      if (activeBlocks.has(block)) {
        const segment = activeBlocks.get(block);
        if (segment.isIgnored) return;

        let relativeText = text;
        if (segment.baselineText) {
          if (text.startsWith(segment.baselineText)) {
            relativeText = text.substring(segment.baselineText.length).trim();
          }
        }
        
        relativeText = relativeText.replace(/\s+/g, ' ').trim();

        if (relativeText && relativeText.length >= 2) {
          if (segment.text !== relativeText) {
            segment.text = relativeText;
            segment.timestamp = new Date().toLocaleTimeString();
            hasUpdates = true;

            if (segment.isPlaceholder) {
              segment.isPlaceholder = false;
              transcript.push(segment);
            }
          }
        }
      } else {
        // Create new segment
        const segment = {
          id: generateUUID(),
          speaker: speaker,
          text: text,
          timestamp: new Date().toLocaleTimeString()
        };
        transcript.push(segment);
        activeBlocks.set(block, segment);
        hasUpdates = true;
        console.log(`[Meet CC Capturer] New speaker block detected: ${speaker}: ${text}`);
      }
    });

    // Cleanup activeBlocks map for elements that are removed from DOM
    for (const [block, segment] of activeBlocks.entries()) {
      if (!captionsContainer.contains(block)) {
        activeBlocks.delete(block);
      }
    }

    if (hasUpdates) {
      sendTranscriptToBackground();
      updateUI();
    }
  };

  // Send the captured transcript to background script
  const sendTranscriptToBackground = () => {
    safeSendMessage({
      type: 'UPDATE_TRANSCRIPT',
      transcript: transcript,
      meetingTitle: document.title,
      url: window.location.href
    });
  };

  // Start observing captions container
  const startObserving = (container) => {
    captionsContainer = container;
    
    mutationObserver = new MutationObserver(handleMutations);
    mutationObserver.observe(captionsContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    isObserving = true;
    console.log("[Meet CC Capturer] MutationObserver started on captions region.");
    
    // Check if there is existing content on start
    handleMutations([]);
    
    safeSendMessage({
      type: 'SET_MEETING_STATUS',
      isCapturing: isCapturing,
      isObserving: true,
      meetingTitle: document.title,
      url: window.location.href
    });

    updateUI();
  };

  // Stop observing captions container
  const stopObserving = () => {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    captionsContainer = null;
    isObserving = false;
    console.log("[Meet CC Capturer] MutationObserver stopped.");

    safeSendMessage({
      type: 'SET_MEETING_STATUS',
      isCapturing: isCapturing,
      isObserving: false,
      meetingTitle: document.title,
      url: window.location.href
    });

    updateUI();
  };

  // Programmatically click the CC button to auto-enable captions
  const autoEnableCaptions = () => {
    const selectors = [
      'button[aria-label*="Turn on captions" i]',
      'button[aria-label*="開啟字幕" i]',
      'button[aria-label*="啟用字幕" i]',
      'button[aria-label*="Turn on subtitles" i]',
      'button[jsname="R5cc2e"]',
      'button[aria-label*="captions" i]',
      'button[aria-label*="字幕" i]'
    ];

    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const ariaPressed = btn.getAttribute('aria-pressed') === 'true';
        
        const isAlreadyOn = ariaPressed || 
                            ariaLabel.toLowerCase().includes('turn off') || 
                            ariaLabel.includes('關閉') || 
                            ariaLabel.includes('禁用');
        
        if (isAlreadyOn) {
          console.log('[Meet CC Capturer] Captions are already ON.');
          return true; // Already on, treat as success
        }

        console.log(`[Meet CC Capturer] Auto-enabling CC via selector: ${selector}`);
        btn.click();
        return true;
      }
    }
    return false;
  };

  // Init loop
  const init = () => {
    injectOverlay();

    // Fetch initial recording state from storage
    chrome.storage.local.get(['activeSession', 'settings'], (res) => {
      const session = res.activeSession;
      const settings = res.settings || {};
      recordingMode = settings.recordMode || 'none';
      if (session && session.isRecording) {
        isRecording = true;
        recordingElapsedSeconds = session.recordingElapsedSeconds || 0;
        recordingMode = session.recordingMode || recordingMode;
        updateUI();
      }
    });

    // Sync storage changes reactively
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.activeSession) {
          const session = changes.activeSession.newValue;
          if (session && session.isRecording) {
            isRecording = true;
            recordingElapsedSeconds = session.recordingElapsedSeconds || 0;
            recordingMode = session.recordingMode || 'none';
          } else {
            isRecording = false;
            recordingElapsedSeconds = 0;
          }
          updateUI();
        }
        if (changes.settings) {
          const settings = changes.settings.newValue || {};
          recordingMode = settings.recordMode || 'none';
          updateUI();
        }
      }
    });

    // Check settings to see if we should auto-enable CC
    let shouldAutoEnable = true;
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};
      if (settings.autoEnableCC !== undefined) {
        shouldAutoEnable = !!settings.autoEnableCC;
      }
    });

    // Check if captions container is available periodically
    checkInterval = setInterval(() => {
      const container = findCaptionsContainer();
      if (container) {
        if (!isObserving) {
          startObserving(container);
        }
      } else {
        if (isObserving) {
          stopObserving();
        }
        // Try to auto-enable captions once if enabled and we haven't done it yet
        if (isCapturing && !hasAutoEnabled && shouldAutoEnable) {
          const success = autoEnableCaptions();
          if (success) {
            hasAutoEnabled = true;
          }
        }
      }
    }, 1500);

    // Initial message to background script to sync page metadata
    safeSendMessage({
      type: 'SYNC_MEETING_INFO',
      meetingTitle: document.title,
      url: window.location.href
    });
  };

  // Listen to messages from popup or background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_TRANSCRIPT') {
      sendResponse({ transcript: transcript, isCapturing: isCapturing, isObserving: isObserving });
    } else if (message.type === 'RECORDING_TICK_FORWARD') {
      recordingElapsedSeconds = message.elapsedSeconds;
      isRecording = true;
      updateUI();
      sendResponse({ status: 'tick_received' });
    } else if (message.type === 'RECORDING_UPLOAD_STATE_FORWARD') {
      uploadState = message.state;
      uploadError = message.error;
      updateUI();
      
      // Auto-clear success or failed state after 5 seconds
      if (uploadState === 'success' || uploadState === 'failed') {
        setTimeout(() => {
          uploadState = null;
          uploadError = null;
          updateUI();
        }, 5000);
      }
      sendResponse({ status: 'upload_state_received' });
    } else if (message.type === 'CLEAR_TRANSCRIPT') {
      transcript = [];
      activeBlocks.clear();
      sendTranscriptToBackground();
      updateUI();
      sendResponse({ status: 'cleared' });
    } else if (message.type === 'FORCE_TOGGLE_CAPTURE') {
      toggleCapture();
      sendResponse({ isCapturing: isCapturing });
    } else if (message.type === 'STOP_AND_CLEAR') {
      isCapturing = false;
      isObserving = false;
      transcript = [];
      activeBlocks.clear();
      if (mutationObserver) {
        mutationObserver.disconnect();
      }
      updateUI();
      sendResponse({ status: 'stopped_and_cleared' });
    } else if (message.type === 'START_CAPTURING') {
      isCapturing = true;
      transcript = [];
      activeBlocks.clear();
      hasAutoEnabled = false;
      const container = findCaptionsContainer();
      if (container) {
        // Mark all existing children in the captions container with their baseline text
        Array.from(container.children).forEach(block => {
          let speaker = 'Speaker';
          let text = '';
          const speakerEl = block.querySelector('.NWpY1d');
          const textEl = block.querySelector('.ygicle.VbkSUe') || block.querySelector('.iTTPOb');
          if (speakerEl && textEl) {
            speaker = speakerEl.innerText.trim();
            text = textEl.innerText.trim();
          } else if (block.children && block.children.length >= 2) {
            speaker = block.children[0].innerText.trim();
            text = block.children[1].innerText.trim();
          } else {
            text = (block.innerText || '').trim();
          }
          text = text.replace(/\s+/g, ' ').trim();

          activeBlocks.set(block, {
            id: generateUUID(),
            speaker: speaker,
            text: '', // Initially empty for this new session
            timestamp: new Date().toLocaleTimeString(),
            baselineText: text,
            isPlaceholder: true // Flag indicating it is a baseline placeholder, not in transcript yet
          });
        });
        startObserving(container);
      }
      updateUI();
      sendResponse({ status: 'started' });
    }
  });

  // Run initial setup
  init();
})();
