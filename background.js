import * as pkce from './lib/pkce.js';
import * as openrouter from './lib/openrouter.js';
import * as watch from './lib/watch.js';

const STORAGE_KEY = 'openrouterKey';
const INSTRUCTION_KEY = 'watchInstruction';
const WRITEUP_MODEL_KEY = 'writeupModel';
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
    case 'SET_WATCH_SETTINGS':
      setWatchSettings(message.instruction, message.writeupModel).then(sendResponse);
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
  const stored = await chrome.storage.local.get([INSTRUCTION_KEY, WRITEUP_MODEL_KEY, INSIGHT_KEY]);
  return {
    instruction: stored[INSTRUCTION_KEY] || '',
    writeupModel: stored[WRITEUP_MODEL_KEY] || '',
    insight: stored[INSIGHT_KEY] || null
  };
}

async function setWatchSettings(instruction, writeupModel) {
  await chrome.storage.local.set({
    [INSTRUCTION_KEY]: (instruction || '').trim(),
    [WRITEUP_MODEL_KEY]: (writeupModel || '').trim()
  });
  return { ok: true };
}

// Two-step cascade, both steps run only when the user clicks "Check now":
// 1. Ask Jev (a cheap structured-decision model) whether the recent YouTube
//    history matches the user's instruction closely enough to be worth
//    mentioning — see lib/watch.js buildJevDecisionRequest.
// 2. Only if that confidence crosses FLAG_THRESHOLD, ask a normal chat model
//    to write the actual note, since Jev itself never returns prose.
async function checkYoutubeHistory() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, INSTRUCTION_KEY, WRITEUP_MODEL_KEY]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');

  const instruction = (stored[INSTRUCTION_KEY] || '').trim();
  if (!instruction) throw new Error('Tell Alux what to watch for first.');

  const writeupModel = (stored[WRITEUP_MODEL_KEY] || '').trim() || openrouter.DEFAULT_WRITEUP_MODEL;

  const entries = await watch.queryYoutubeHistory();
  if (entries.length === 0) {
    throw new Error('No recent YouTube watch history found in the browser.');
  }

  const decisionRequest = watch.buildJevDecisionRequest(instruction, entries);
  const answers = await openrouter.askJevDecision(apiKey, decisionRequest);
  const confidence = answers?.should_flag?.noul ?? 0;
  const flagged = confidence >= watch.FLAG_THRESHOLD;

  const text = flagged
    ? await openrouter.sendChatMessage(apiKey, watch.buildWriteupMessages(instruction, entries), writeupModel)
    : "Alux checked — nothing in your recent YouTube history matched what you asked it to watch for.";

  const insight = { text, at: Date.now(), flagged, confidence };
  await chrome.storage.local.set({ [INSIGHT_KEY]: insight });
  return insight;
}
