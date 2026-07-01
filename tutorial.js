/**
 * Auto Meeting Minutes - Tutorial Page JS
 * Compliant with Chrome Extension MV3 Content Security Policy (no inline scripts).
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnCopyGas = document.getElementById('btn-copy-gas');
  const gasCode = document.getElementById('gas-code');

  if (btnCopyGas && gasCode) {
    btnCopyGas.addEventListener('click', () => {
      const codeText = gasCode.innerText;
      navigator.clipboard.writeText(codeText).then(() => {
        const originalText = btnCopyGas.innerText;
        btnCopyGas.innerText = '已複製！';
        btnCopyGas.style.backgroundColor = '#10b981';
        btnCopyGas.style.borderColor = '#10b981';
        
        setTimeout(() => {
          btnCopyGas.innerText = originalText;
          btnCopyGas.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
          btnCopyGas.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy text:', err);
        alert('複製失敗，請手動選取文字複製。');
      });
    });
  }
});
