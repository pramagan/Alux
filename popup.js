const statusEl = document.getElementById('status');
const connectView = document.getElementById('connect-view');
const watchView = document.getElementById('watch-view');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const instructionInput = document.getElementById('instruction-input');
const saveInstructionBtn = document.getElementById('save-instruction-btn');
const checkHistoryBtn = document.getElementById('check-history-btn');
const historyError = document.getElementById('history-error');
const insightEl = document.getElementById('insight');
const insightText = document.getElementById('insight-text');
const insightTime = document.getElementById('insight-time');

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(connected) {
  statusEl.textContent = connected ? 'connected' : 'not connected';
  statusEl.classList.toggle('connected', connected);
  connectView.hidden = connected;
  watchView.hidden = !connected;
}

function renderInsight(insight) {
  if (!insight) {
    insightEl.hidden = true;
    return;
  }
  insightText.textContent = insight.text;
  insightTime.textContent = `checked ${new Date(insight.at).toLocaleString()}`;
  insightEl.hidden = false;
}

async function refreshStatus() {
  const { connected } = await send({ type: 'GET_STATUS' });
  renderStatus(connected);
  if (connected) await refreshWatchSettings();
}

async function refreshWatchSettings() {
  const { instruction, insight } = await send({ type: 'GET_WATCH_SETTINGS' });
  instructionInput.value = instruction;
  renderInsight(insight);
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

saveInstructionBtn.addEventListener('click', async () => {
  await send({ type: 'SET_WATCH_INSTRUCTION', instruction: instructionInput.value });
  const original = saveInstructionBtn.textContent;
  saveInstructionBtn.textContent = 'Saved';
  setTimeout(() => { saveInstructionBtn.textContent = original; }, 1200);
});

checkHistoryBtn.addEventListener('click', async () => {
  historyError.hidden = true;
  checkHistoryBtn.disabled = true;
  checkHistoryBtn.textContent = 'Watching…';

  await send({ type: 'SET_WATCH_INSTRUCTION', instruction: instructionInput.value });
  const result = await send({ type: 'CHECK_YOUTUBE_HISTORY' });

  checkHistoryBtn.disabled = false;
  checkHistoryBtn.textContent = 'Check now';

  if (!result.ok) {
    historyError.textContent = result.error;
    historyError.hidden = false;
    return;
  }
  renderInsight(result.insight);
});

refreshStatus();
