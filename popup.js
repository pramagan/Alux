const statusEl = document.getElementById('status');
const connectView = document.getElementById('connect-view');
const chatView = document.getElementById('chat-view');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const messagesEl = document.getElementById('messages');
const instructionInput = document.getElementById('instruction-input');
const saveInstructionBtn = document.getElementById('save-instruction-btn');
const checkHistoryBtn = document.getElementById('check-history-btn');
const historyError = document.getElementById('history-error');
const insightEl = document.getElementById('insight');
const insightText = document.getElementById('insight-text');
const insightTime = document.getElementById('insight-time');

const history = [];

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(connected) {
  statusEl.textContent = connected ? 'connected' : 'not connected';
  statusEl.classList.toggle('connected', connected);
  connectView.hidden = connected;
  chatView.hidden = !connected;
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  history.length = 0;
  messagesEl.innerHTML = '';
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

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  appendMessage('user', text);
  history.push({ role: 'user', content: text });

  const result = await send({ type: 'CHAT', messages: history });
  if (!result.ok) {
    appendMessage('assistant', `Error: ${result.error}`);
    return;
  }
  appendMessage('assistant', result.reply);
  history.push({ role: 'assistant', content: result.reply });
});

refreshStatus();
