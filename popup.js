const statusEl = document.getElementById('status');
const connectView = document.getElementById('connect-view');
const watchView = document.getElementById('watch-view');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const instructionInput = document.getElementById('instruction-input');
const voiceSelect = document.getElementById('voice-select');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const checkHistoryBtn = document.getElementById('check-history-btn');
const historyError = document.getElementById('history-error');
const insightEl = document.getElementById('insight');
const insightText = document.getElementById('insight-text');
const insightTime = document.getElementById('insight-time');
const speakBtn = document.getElementById('speak-btn');
const strikeCountEl = document.getElementById('strike-count');

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(connected) {
  statusEl.textContent = connected ? 'connected' : 'not connected';
  statusEl.classList.toggle('connected', connected);
  connectView.hidden = connected;
  watchView.hidden = !connected;
}

function renderStrikeCount(strikeCount) {
  if (!strikeCount) {
    strikeCountEl.hidden = true;
    return;
  }
  strikeCountEl.textContent = `🔥 ${strikeCount} strike${strikeCount === 1 ? '' : 's'}`;
  strikeCountEl.hidden = false;
}

// Resolves once playback actually finishes (or errors out) — needed so
// callers can tell "voice ends" apart from "voice started".
function playAudioUrl(url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.addEventListener('ended', resolve);
    audio.addEventListener('error', resolve);
    audio.play().catch(resolve);
  });
}

function speakWithBrowserVoice(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.addEventListener('end', resolve);
    utterance.addEventListener('error', resolve);
    window.speechSynthesis.speak(utterance);
  });
}

// Tries OpenRouter's TTS model first (natural voice); falls back to the
// browser's built-in speechSynthesis if that fails (e.g. not connected yet).
// Resolves once the voice has actually finished speaking. `isInitialAlert`
// marks the very first time a flagged note gets spoken (from "Check now") —
// once the voice ends, the alert is considered delivered: the strike gets
// recorded, the stored message cleared server-side, the browser gets
// redirected to a YouTube search for the suggested alternative (`searchQuery`
// — see directToYoutubeSearch() in background.js), and the note removed from
// view here. Replaying via the 🔊 button afterward passes neither flag, so it
// never re-triggers any of that.
// Disabled for the whole call (not just the click) so autoSpeak and Replay
// can't overlap each other either — otherwise two voices can end up playing
// on top of one another.
async function speakText(text, { isInitialAlert = false, searchQuery = null } = {}) {
  if (!text) return;

  const originalLabel = speakBtn.textContent;
  speakBtn.disabled = true;
  speakBtn.textContent = '🔊 Playing…';

  try {
    const result = await send({ type: 'SPEAK_TEXT', text });
    if (result.ok) {
      await playAudioUrl(result.audioUrl);
    } else {
      console.warn('OpenRouter TTS failed, falling back to browser voice:', result.error);
      await speakWithBrowserVoice(text);
    }

    if (isInitialAlert) {
      const { strikeCount } = await send({ type: 'ALERT_DELIVERED', searchQuery });
      renderStrikeCount(strikeCount);
      insightEl.hidden = true;
    }
  } finally {
    speakBtn.disabled = false;
    speakBtn.textContent = originalLabel;
  }
}

function renderInsight(insight, { autoSpeak = false } = {}) {
  if (!insight) {
    insightEl.hidden = true;
    return;
  }
  insightText.textContent = insight.text;
  const checkedAt = `checked ${new Date(insight.at).toLocaleString()}`;
  if (insight.flagged) {
    const confidencePct = Math.round((insight.confidence ?? 0) * 100);
    insightTime.textContent = `${checkedAt} · Jev confidence ${confidencePct}%`;
  } else {
    insightTime.textContent = checkedAt;
  }
  insightEl.hidden = false;
  speakBtn.hidden = false;

  if (autoSpeak && insight.flagged) {
    speakText(insight.text, { isInitialAlert: true, searchQuery: insight.searchQuery });
  }
}

speakBtn.addEventListener('click', () => speakText(insightText.textContent));

async function refreshStatus() {
  const { connected } = await send({ type: 'GET_STATUS' });
  renderStatus(connected);
  if (connected) await refreshWatchSettings();
}

async function refreshWatchSettings() {
  const { instruction, ttsVoice, insight, strikeCount } = await send({ type: 'GET_WATCH_SETTINGS' });
  instructionInput.value = instruction;
  voiceSelect.value = ttsVoice;
  renderInsight(insight);
  renderStrikeCount(strikeCount);
}

connectBtn.addEventListener('click', async () => {
  connectError.hidden = true;
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  const result = await send({ type: 'CONNECT' });
  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect OpenRouter account';
  if (!result.ok) {
    connectError.textContent = result.error;
    connectError.hidden = false;
    return;
  }
  await refreshStatus();
});

disconnectBtn.addEventListener('click', async () => {
  await send({ type: 'DISCONNECT' });
  await refreshStatus();
});

saveSettingsBtn.addEventListener('click', async () => {
  await send({ type: 'SET_WATCH_SETTINGS', instruction: instructionInput.value, ttsVoice: voiceSelect.value });
  const original = saveSettingsBtn.textContent;
  saveSettingsBtn.textContent = 'Saved';
  setTimeout(() => { saveSettingsBtn.textContent = original; }, 1200);
});

checkHistoryBtn.addEventListener('click', async () => {
  historyError.hidden = true;
  checkHistoryBtn.disabled = true;
  checkHistoryBtn.textContent = 'Watching…';

  await send({ type: 'SET_WATCH_SETTINGS', instruction: instructionInput.value, ttsVoice: voiceSelect.value });
  const result = await send({ type: 'CHECK_YOUTUBE_HISTORY' });

  checkHistoryBtn.disabled = false;
  checkHistoryBtn.textContent = 'Check now';

  if (!result.ok) {
    historyError.textContent = result.error;
    historyError.hidden = false;
    return;
  }
  renderInsight(result.insight, { autoSpeak: true });
});

refreshStatus();
