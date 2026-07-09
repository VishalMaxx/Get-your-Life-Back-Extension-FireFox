// offscreen.js - runs in the offscreen document context to play notification sounds in MV3.
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'PLAY_SOUND') {
    const audio = new Audio(message.file);
    
    audio.onended = () => {
      chrome.offscreen.closeDocument().catch(() => {});
    };
    
    audio.play().catch(err => {
      console.error("Offscreen audio playback failed:", err);
      chrome.offscreen.closeDocument().catch(() => {});
    });
  }
});
