const statusEl = document.getElementById('status');
const connectView = document.getElementById('connect-view');
const chatView = document.getElementById('chat-view');
const connectBtn = document.getElementById('connect-btn');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const messagesEl = document.getElementById('messages');

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

async function refreshStatus() {
  const { connected } = await send({ type: 'GET_STATUS' });
  renderStatus(connected);
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
