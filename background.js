import * as pkce from './lib/pkce.js';
import * as openrouter from './lib/openrouter.js';
import * as watch from './lib/watch.js';

const STORAGE_KEY = 'openrouterKey';
const INSTRUCTION_KEY = 'watchInstruction';
const INSIGHT_KEY = 'lastInsight';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'CONNECT':
      connect().then(sendResponse);
      return true; // keep the message channel open for the async response
    case 'DISCONNECT':
      disconnect().then(sendResponse);
      return true;
    case 'GET_STATUS':
      getStatus().then(sendResponse);
      return true;
    case 'GET_WATCH_SETTINGS':
      getWatchSettings().then(sendResponse);
      return true;
    case 'SET_WATCH_INSTRUCTION':
      setWatchInstruction(message.instruction).then(sendResponse);
      return true;
    case 'CHECK_YOUTUBE_HISTORY':
      checkYoutubeHistory()
        .then((insight) => sendResponse({ ok: true, insight }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    default:
      return false;
  }
});

async function connect() {
  const codeVerifier = pkce.generateCodeVerifier();
  const codeChallenge = await pkce.generateCodeChallenge(codeVerifier);
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = openrouter.buildAuthUrl({
    callbackUrl: redirectUrl,
    codeChallenge,
    keyLabel: 'Alux'
  });

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Authorization was cancelled.' });
        return;
      }
      try {
        const code = new URL(responseUrl).searchParams.get('code');
        if (!code) throw new Error('OpenRouter did not return an authorization code.');
        const apiKey = await openrouter.exchangeCodeForKey(code, codeVerifier);
        await chrome.storage.local.set({ [STORAGE_KEY]: apiKey });
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

async function disconnect() {
  await chrome.storage.local.remove(STORAGE_KEY);
  return { ok: true };
}

async function getStatus() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { connected: Boolean(stored[STORAGE_KEY]) };
}

async function getWatchSettings() {
  const stored = await chrome.storage.local.get([INSTRUCTION_KEY, INSIGHT_KEY]);
  return {
    instruction: stored[INSTRUCTION_KEY] || '',
    insight: stored[INSIGHT_KEY] || null
  };
}

async function setWatchInstruction(instruction) {
  await chrome.storage.local.set({ [INSTRUCTION_KEY]: (instruction || '').trim() });
  return { ok: true };
}

// Reads recent YouTube watch history (only when the user asks — see popup.js)
// and asks jev-latest to reflect on it against the user's own instruction.
async function checkYoutubeHistory() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, INSTRUCTION_KEY]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');

  const instruction = (stored[INSTRUCTION_KEY] || '').trim();
  if (!instruction) throw new Error('Tell Alux what to watch for first.');

  const entries = await watch.queryYoutubeHistory();
  if (entries.length === 0) {
    throw new Error('No recent YouTube watch history found in the browser.');
  }

  const messages = watch.buildWatchMessages(instruction, entries);
  const text = await openrouter.sendChatMessage(apiKey, messages);

  const insight = { text, at: Date.now() };
  await chrome.storage.local.set({ [INSIGHT_KEY]: insight });
  return insight;
}
