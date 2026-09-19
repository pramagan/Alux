import * as pkce from './lib/pkce.js';
import * as openrouter from './lib/openrouter.js';

const STORAGE_KEY = 'openrouterKey';

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
    case 'CHAT':
      chat(message.messages)
        .then((reply) => sendResponse({ ok: true, reply }))
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
    keyLabel: 'Jev Chat Extension'
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

async function chat(messages) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');
  return openrouter.sendChatMessage(apiKey, messages);
}
