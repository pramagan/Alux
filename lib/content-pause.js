// Injected into YouTube tabs so Alux can interrupt whatever's playing —
// pausing the video and, for the unattended periodic check (which has no
// popup open to play audio in), playing the spoken note directly on the page.
// See pauseYoutubeVideos() / playAudioInYoutubeTabs() in background.js.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PAUSE_VIDEO') {
    document.querySelectorAll('video').forEach((video) => {
      if (!video.paused) video.pause();
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'PLAY_AUDIO') {
    new Audio(message.audioUrl).play().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
