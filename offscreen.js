// offscreen.js - Handles tab media capture and microphone audio mixing in Manifest V3

let mediaRecorder = null;
let recordedChunks = [];
let tabAudioStream = null;
let micAudioStream = null;
let tabVideoStream = null;
let combinedStream = null;
let audioCtx = null;
let timerInterval = null;
let elapsedSeconds = 0;
let activeSettings = {};

const offscreenLogEvent = (module, logType, message) => {
  chrome.runtime.sendMessage({
    type: 'ADD_LOG_ENTRY',
    module,
    logType,
    message
  }).catch(() => {});
};

// Listen to control commands from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Offscreen] Received message:", message.type);

  if (message.type === 'START_RECORDING' || message.type === 'START_RECORDING_WITH_STREAM_ID') {
    (async () => {
      try {
        const { targetTabId, tabStreamId, desktopStreamId, includeMic, recordingMode, captureSource, filename, settings } = message;
        activeSettings = settings || {};
        recordedChunks = [];
        elapsedSeconds = 0;

        console.log("[Offscreen] Got tabStreamId:", tabStreamId, "desktopStreamId:", desktopStreamId);

        let tabVideoStream = null;
        let tabAudioStream = null;
        let tabStream = null;
        let desktopAudioStream = null;
        let desktopVideoStream = null;

        if (captureSource === 'desktop' && desktopStreamId) {
          // Double stream mode: capture audio from tabStreamId and video from desktopStreamId separately
          
          // 1. Capture tab audio from Google Meet page
          try {
            console.log("[Offscreen] Capturing tab audio stream from tabStreamId...");
            const tabAudioConstraints = {
              audio: {
                mandatory: {
                  chromeMediaSource: 'tab',
                  chromeMediaSourceId: tabStreamId
                }
              }
            };
            desktopAudioStream = await navigator.mediaDevices.getUserMedia(tabAudioConstraints);
            const audioTracks = desktopAudioStream.getAudioTracks();
            if (audioTracks.length > 0) {
              tabAudioStream = new MediaStream([audioTracks[0]]);
              console.log("[Offscreen] Tab audio track captured successfully.");
            }
          } catch (audioErr) {
            console.error("[Offscreen] Failed to capture tab audio:", audioErr);
            offscreenLogEvent('Recording', 'warning', `無法取得分頁音訊: ${audioErr.message}`);
          }

          // 2. Capture desktop video (if video mode)
          if (recordingMode === 'video') {
            try {
              console.log("[Offscreen] Capturing desktop video stream from desktopStreamId...");
              const desktopVideoConstraints = {
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: desktopStreamId,
                    maxWidth: 1280,
                    maxHeight: 720,
                    maxFrameRate: 15
                  }
                }
              };
              desktopVideoStream = await navigator.mediaDevices.getUserMedia(desktopVideoConstraints);
              const videoTracks = desktopVideoStream.getVideoTracks();
              if (videoTracks.length > 0) {
                tabVideoStream = new MediaStream([videoTracks[0]]);
                console.log("[Offscreen] Desktop video track captured successfully.");
              }
            } catch (videoErr) {
              console.error("[Offscreen] Failed to capture desktop video:", videoErr);
              throw new Error(`無法擷取共用螢幕/視窗畫面: ${videoErr.message}`);
            }
          }
        } else {
          // Single stream mode: capture both audio and video from tabStreamId (or message.streamId as fallback)
          const singleStreamId = tabStreamId || message.streamId;
          if (!singleStreamId) {
            throw new Error("Missing streamId for tab capture.");
          }

          const captureConstraints = {
            audio: {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: singleStreamId
              }
            }
          };

          if (recordingMode === 'video') {
            captureConstraints.video = {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: singleStreamId,
                maxWidth: 1280,
                maxHeight: 720,
                maxFrameRate: 15
              }
            };
          }

          try {
            tabStream = await navigator.mediaDevices.getUserMedia(captureConstraints);
            console.log("[Offscreen] Tab stream captured successfully.");
            
            const tabAudioTracks = tabStream.getAudioTracks();
            if (tabAudioTracks.length > 0) {
              tabAudioStream = new MediaStream([tabAudioTracks[0]]);
            }
            if (recordingMode === 'video') {
              const tabVideoTracks = tabStream.getVideoTracks();
              if (tabVideoTracks.length > 0) {
                tabVideoStream = new MediaStream([tabVideoTracks[0]]);
              }
            }
          } catch (err) {
            console.error("[Offscreen] Failed to capture tab constraints:", err);
            throw new Error(`無法擷取分頁音軌與視訊: ${err.message}`);
          }
        }

      // Playback tab audio back to local speakers so the user can hear the meeting normally
      if (tabAudioStream) {
        const playbackAudio = document.getElementById('playback-audio');
        if (playbackAudio) {
          playbackAudio.srcObject = tabAudioStream;
          playbackAudio.volume = 1.0;
          console.log("[Offscreen] Routed tab audio stream to local speakers.");
        }
      }

      // 3. Optional: Get Microphone stream and mix using Web Audio API
      let mixedAudioStream = tabAudioStream;

      if (includeMic) {
        try {
          console.log("[Offscreen] Requesting microphone stream...");
          micAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          console.log("[Offscreen] Microphone stream captured.");

          if (tabAudioStream && micAudioStream) {
            // Setup Web Audio graph for mixing
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            
            const tabSource = audioCtx.createMediaStreamSource(tabAudioStream);
            const micSource = audioCtx.createMediaStreamSource(micAudioStream);
            const destination = audioCtx.createMediaStreamDestination();

            // Connect sources to mixer destination
            tabSource.connect(destination);
            micSource.connect(destination);

            mixedAudioStream = destination.stream;
            console.log("[Offscreen] Tab audio and Microphone audio mixed successfully.");
          } else if (micAudioStream) {
            mixedAudioStream = micAudioStream;
            console.log("[Offscreen] No tab audio, recording microphone audio only.");
          }
        } catch (micErr) {
          console.error("[Offscreen] Failed to capture microphone. Fallback to tab audio only:", micErr);
          // Fallback to tab audio only
        }
      }

      // 4. Combine audio and video tracks into combinedStream for recording
      const finalTracks = [];
      if (mixedAudioStream) {
        const audioTrack = mixedAudioStream.getAudioTracks()[0];
        if (audioTrack) finalTracks.push(audioTrack);
      }
      if (recordingMode === 'video' && tabVideoStream) {
        const videoTrack = tabVideoStream.getVideoTracks()[0];
        if (videoTrack) finalTracks.push(videoTrack);
      }

      combinedStream = new MediaStream(finalTracks);

      // 5. Select compatible MIME type
      let mimeType = 'audio/webm;codecs=opus';
      if (recordingMode === 'video') {
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
          mimeType = 'video/webm;codecs=vp9,opus';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
          mimeType = 'video/webm;codecs=vp8,opus';
        } else {
          mimeType = 'video/webm';
        }
      }
      console.log("[Offscreen] Using MediaRecorder MIME type:", mimeType);

      // 6. Initialize MediaRecorder with custom video bitrate for size compression
      const recOptions = { mimeType };
      if (recordingMode === 'video') {
        recOptions.videoBitsPerSecond = 800000; // 800 kbps (saves ~80% storage size, ideal for slides/meet)
      }
      mediaRecorder = new MediaRecorder(combinedStream, recOptions);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log("[Offscreen] MediaRecorder stopped. Packaging recording file...");
        offscreenLogEvent('Recording', 'info', `會議錄製結束，共獲取了 ${recordedChunks.length} 個影音數據區塊，準備封裝...`);
        
        // Stop all track devices to release camera/mic indicators
        if (tabStream) tabStream.getTracks().forEach(t => t.stop());
        if (desktopAudioStream) desktopAudioStream.getTracks().forEach(t => t.stop());
        if (desktopVideoStream) desktopVideoStream.getTracks().forEach(t => t.stop());
        if (micAudioStream) micAudioStream.getTracks().forEach(t => t.stop());
        if (combinedStream) combinedStream.getTracks().forEach(t => t.stop());

        if (recordedChunks.length === 0) {
          console.warn("[Offscreen] No chunks recorded.");
          return;
        }

        const uploadTarget = activeSettings.webmUploadTarget || 'none';
        const webhookUrl = activeSettings.webmWebhookUrl;
        const nextcloudUrl = activeSettings.nextcloudWebdavUrl;
        const nextcloudUser = activeSettings.nextcloudUsername;
        const nextcloudPass = activeSettings.nextcloudPassword;

        const blob = new Blob(recordedChunks, { type: mimeType });
        const downloadUrl = URL.createObjectURL(blob);

        const triggerDownloadAndClose = () => {
          // Send the blob URL to background.js for download (since offscreen context lacks chrome.downloads access)
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_RECORDING_BLOB',
            url: downloadUrl,
            filename: filename
          }, (response) => {
            console.log("[Offscreen] Broadcasted download request to background. Response:", response);
            // Clean up the URL object
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
          });
        };

        // 1. Upload to Gemini File API if Multimodal direct file analysis is selected
        const isLlmGemini = !activeSettings.llmSource || activeSettings.llmSource === 'gemini';
        if (activeSettings.aiInputSource === 'file' && isLlmGemini && activeSettings.geminiApiKey) {
          console.log("[Offscreen] AI Input Source is 'file' and using Gemini. Uploading WebM to Gemini File API...");
          offscreenLogEvent('Upload', 'info', `開始直傳影音檔至 Gemini File API (大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB)...`);
          chrome.runtime.sendMessage({
            type: 'RECORDING_UPLOAD_STATE',
            state: 'uploading'
          }).catch(() => {});

          try {
            const uploadInitRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${activeSettings.geminiApiKey}`, {
              method: 'POST',
              headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': String(blob.size),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                file: {
                  display_name: filename.replace(/\.[^/.]+$/, "")
                }
              })
            });

            if (!uploadInitRes.ok) {
              throw new Error(`Gemini File API Init failed: ${uploadInitRes.status}`);
            }

            const uploadUrl = uploadInitRes.headers.get('X-Goog-Upload-URL') || uploadInitRes.headers.get('x-goog-upload-url');
            if (!uploadUrl) {
              throw new Error("Failed to get X-Goog-Upload-URL from Gemini headers.");
            }

            const uploadDataRes = await fetch(uploadUrl, {
              method: 'POST',
              headers: {
                'Content-Length': String(blob.size),
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize'
              },
              body: blob
            });

            if (!uploadDataRes.ok) {
              throw new Error(`Gemini File API Upload failed: ${uploadDataRes.status}`);
            }

            const uploadResult = await uploadDataRes.json();
            const recordingFileUri = uploadResult.file?.uri;
            console.log("[Offscreen] Gemini File API upload successful. URI:", recordingFileUri);
            offscreenLogEvent('Upload', 'success', `成功上傳影音檔至 Gemini File API！連結: ${recordingFileUri}`);

            // Update session storage with Gemini file URI via background message
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({
                type: 'UPDATE_SESSION_RECORDING_URI',
                recordingFileUri: recordingFileUri,
                recordingFileMimeType: mimeType
              }, () => {
                resolve();
              });
            });
          } catch (geminiErr) {
            offscreenLogEvent('Upload', 'error', `上傳影音檔至 Gemini File API 失敗: ${geminiErr.message || geminiErr}`);
            console.error("[Offscreen] Failed to upload WebM to Gemini File API:", geminiErr);
          }
        }

        // 2. Proceed to next upload target if configured
        if (uploadTarget === 'webhook' && webhookUrl) {
          console.log(`[Offscreen] WebM Webhook enabled. Uploading file to ${webhookUrl}...`);
          offscreenLogEvent('Upload', 'info', `開始上傳影音檔至自訂 Webhook (大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB)...`);
          // Forward upload state to background / content script
          chrome.runtime.sendMessage({
            type: 'RECORDING_UPLOAD_STATE',
            state: 'uploading'
          }).catch(() => {});

          try {
            const formData = new FormData();
            formData.append('file', blob, filename);
            formData.append('title', filename.replace(/_record\.webm$/, ''));
            formData.append('timestamp', String(Date.now()));

            const uploadRes = await fetch(webhookUrl, {
              method: 'POST',
              body: formData
            });

            if (uploadRes.ok) {
              console.log("[Offscreen] WebM Webhook upload successful!");
              offscreenLogEvent('Upload', 'success', `成功上傳影音檔至自訂 Webhook 伺服器！`);
              chrome.runtime.sendMessage({
                type: 'RECORDING_UPLOAD_STATE',
                state: 'success'
              }).catch(() => {});
            } else {
              throw new Error(`Server returned HTTP ${uploadRes.status}`);
            }
          } catch (uploadErr) {
            offscreenLogEvent('Upload', 'error', `上傳影音檔至 Webhook 失敗: ${uploadErr.message || uploadErr}`);
            console.error("[Offscreen] WebM Webhook upload failed:", uploadErr);
            chrome.runtime.sendMessage({
              type: 'RECORDING_UPLOAD_STATE',
              state: 'failed',
              error: uploadErr.message
            }).catch(() => {});
          } finally {
            // Always trigger local backup download and offscreen closure after upload attempt finishes
            triggerDownloadAndClose();
          }
        } else if (uploadTarget === 'nextcloud' && nextcloudUrl && nextcloudUser) {
          console.log(`[Offscreen] Direct Nextcloud upload enabled. Uploading file via WebDAV...`);
          offscreenLogEvent('Upload', 'info', `開始上傳影音檔至 Nextcloud WebDAV (大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB)...`);
          // Forward upload state to background / content script
          chrome.runtime.sendMessage({
            type: 'RECORDING_UPLOAD_STATE',
            state: 'uploading'
          }).catch(() => {});

          try {
            // Encode to Base64 for Basic Auth header safely
            const credentials = nextcloudUser + ':' + (nextcloudPass || '');
            const authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(credentials)));
            
            // Append filename to Nextcloud WebDAV directory path
            const targetUrl = `${nextcloudUrl.replace(/\/$/, '')}/${filename}`;

            const uploadRes = await fetch(targetUrl, {
              method: 'PUT',
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/octet-stream'
              },
              body: blob
            });

            if (uploadRes.ok || uploadRes.status === 201 || uploadRes.status === 204) {
              console.log("[Offscreen] Nextcloud WebDAV upload successful!");
              offscreenLogEvent('Upload', 'success', `成功上傳影音檔至 Nextcloud 雲端！檔名: ${filename}`);
              chrome.runtime.sendMessage({
                type: 'RECORDING_UPLOAD_STATE',
                state: 'success'
              }).catch(() => {});
            } else {
              throw new Error(`Server returned HTTP ${uploadRes.status}`);
            }
          } catch (uploadErr) {
            offscreenLogEvent('Upload', 'error', `上傳影音檔至 Nextcloud 失敗: ${uploadErr.message || uploadErr}`);
            console.error("[Offscreen] Nextcloud WebDAV upload failed:", uploadErr);
            chrome.runtime.sendMessage({
              type: 'RECORDING_UPLOAD_STATE',
              state: 'failed',
              error: uploadErr.message
            }).catch(() => {});
          } finally {
            // Always trigger local backup download and offscreen closure after upload attempt finishes
            triggerDownloadAndClose();
          }
        } else {
          // No upload configured, proceed to download directly
          triggerDownloadAndClose();
        }
      };

      // 7. Start recording
      mediaRecorder.start(1000); // Collect data slice every 1 second
      console.log("[Offscreen] MediaRecorder started recording.");

      // Start elapsed timer
      startTimer();

        sendResponse({ status: 'started' });
      } catch (err) {
        console.error("[Offscreen] Failed to start recording:", err);
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  else if (message.type === 'STOP_RECORDING') {
    stopTimer();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close();
      }
      console.log("[Offscreen] Stopped recording.");
      sendResponse({ status: 'stopped' });
    } else {
      console.log("[Offscreen] No active recording to stop.");
      sendResponse({ status: 'no_active_recording' });
    }
  }

  else if (message.type === 'PAUSE_RECORDING') {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      stopTimer();
      console.log("[Offscreen] Paused recording.");
      sendResponse({ status: 'paused' });
    } else {
      sendResponse({ status: 'ignored' });
    }
  }

  else if (message.type === 'RESUME_RECORDING') {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      startTimer();
      console.log("[Offscreen] Resumed recording.");
      sendResponse({ status: 'resumed' });
    } else {
      sendResponse({ status: 'ignored' });
    }
  }
  return true; // Keep message channel open for async responses
});

// Helper functions for elapsed timer
const startTimer = () => {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    // Broadcast elapsed time back to background.js
    chrome.runtime.sendMessage({
      type: 'RECORDING_TICK',
      elapsedSeconds: elapsedSeconds
    }).catch(() => {}); // Catch errors in case background is asleep or disconnected
  }, 1000);
};

const stopTimer = () => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
};

// Send ready message to background when loaded
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
