const statusEl = document.getElementById('status');
const connectView = document.getElementById('connect-view');
const watchView = document.getElementById('watch-view');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const instructionInput = document.getElementById('instruction-input');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const checkHistoryBtn = document.getElementById('check-history-btn');
const historyError = document.getElementById('history-error');
const insightEl = document.getElementById('insight');
const insightText = document.getElementById('insight-text');
const insightTime = document.getElementById('insight-time');
const searchLink = document.getElementById('search-link');
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
  const count = strikeCount || 0;
  strikeCountEl.textContent = `🔥 ${count} strike${count === 1 ? '' : 's'}`;
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
// once the voice ends, the alert is considered delivered and the strike
// gets recorded. There is no automatic redirect: the suggested alternative
// stays visible as a clickable link (see renderInsight below) that the user
// opens themselves, whenever they want. Replaying via the 🔊 button
// afterward passes neither flag, so it never re-records a strike.
// Disabled for the whole call (not just the click) so autoSpeak and Replay
// can't overlap each other either — otherwise two voices can end up playing
// on top of one another.
async function speakText(text, { isInitialAlert = false } = {}) {
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
      const { strikeCount } = await send({ type: 'ALERT_DELIVERED' });
      renderStrikeCount(strikeCount);
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
  insightTime.textContent = `checked ${new Date(insight.at).toLocaleString()}`;
  insightEl.hidden = false;
  speakBtn.hidden = false;

  if (insight.searchQuery) {
    searchLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(insight.searchQuery)}`;
    searchLink.hidden = false;
  } else {
    searchLink.hidden = true;
  }

  if (autoSpeak && insight.flagged) {
    speakText(insight.text, { isInitialAlert: true });
  }
}

speakBtn.addEventListener('click', () => speakText(insightText.textContent));

async function refreshStatus() {
  const { connected } = await send({ type: 'GET_STATUS' });
  renderStatus(connected);
  if (connected) await refreshWatchSettings();
}

async function refreshWatchSettings() {
  const { instruction, insight, strikeCount } = await send({ type: 'GET_WATCH_SETTINGS' });
  instructionInput.value = instruction;
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
  await send({ type: 'SET_WATCH_SETTINGS', instruction: instructionInput.value });
  const original = saveSettingsBtn.textContent;
  saveSettingsBtn.textContent = 'Saved';
  setTimeout(() => { saveSettingsBtn.textContent = original; }, 1200);
});

checkHistoryBtn.addEventListener('click', async () => {
  historyError.hidden = true;
  checkHistoryBtn.disabled = true;
  checkHistoryBtn.textContent = 'Watching…';

  await send({ type: 'SET_WATCH_SETTINGS', instruction: instructionInput.value });
  const result = await send({ type: 'CHECK_YOUTUBE_HISTORY' });

  checkHistoryBtn.disabled = false;
  checkHistoryBtn.textContent = 'Check now';

  if (!result.ok) {
    historyError.textContent = result.error;
    historyError.hidden = false;
    return;
  }
  renderStrikeCount(result.insight.strikeCount);
  renderInsight(result.insight, { autoSpeak: true });
});

refreshStatus();
