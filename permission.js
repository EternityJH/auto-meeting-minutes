// permission.js - Tab context page for prompting microphone access in Manifest V3

document.addEventListener('DOMContentLoaded', () => {
  const btnRequest = document.getElementById('btn-request');
  const statusMsg = document.getElementById('status-msg');

  const requestPermission = async () => {
    statusMsg.className = 'status';
    statusMsg.innerText = '正在要求麥克風權限...';

    try {
      // Prompt browser permission dialog
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Stop all tracks immediately as we only needed the permission flag
      stream.getTracks().forEach(track => track.stop());
      
      statusMsg.className = 'status success';
      statusMsg.innerText = '✓ 授權成功！此視窗將於 1 秒後自動關閉。';
      btnRequest.style.display = 'none';

      // Save state to confirm we have been granted
      chrome.storage.local.get(['settings'], (res) => {
        const settings = res.settings || {};
        settings.recordMicGranted = true;
        chrome.storage.local.set({ settings });
      });

      // Auto-close tab
      setTimeout(() => {
        window.close();
      }, 1200);

    } catch (err) {
      console.error("Microphone access denied:", err);
      statusMsg.className = 'status error';
      statusMsg.innerHTML = `
        <strong>授權失敗</strong><br>
        請點擊瀏覽器網址列左側的 🔒 (鎖頭) 或 ⚙ (設定) 圖示，將「麥克風」權限調整為<strong>「允許」</strong>，然後重新整理此頁面。
      `;
    }
  };

  btnRequest.addEventListener('click', requestPermission);

  // Auto trigger on load
  requestPermission();
});
