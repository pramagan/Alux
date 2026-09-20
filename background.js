import * as pkce from './lib/pkce.js';
import * as openrouter from './lib/openrouter.js';
import * as watch from './lib/watch.js';
import * as reflection from './lib/reflection.js';
import * as videoinfo from './lib/videoinfo.js';

const STORAGE_KEY = 'openrouterKey';
const INSTRUCTION_KEY = 'watchInstruction';
const WRITEUP_MODEL_KEY = 'writeupModel';
const TTS_MODEL_KEY = 'ttsModel';
const TTS_VOICE_KEY = 'ttsVoice';
const INSIGHT_KEY = 'lastInsight';
// Per-video Jev classifications and past messages, kept so notes can be
// tailored to whether the user actually changed behavior since the last one
// — see lib/reflection.js.
const VIDEO_LOG_KEY = 'videoClassificationLog';
const MESSAGE_LOG_KEY = 'messageLog';
const MAX_VIDEO_LOG = 500;
const MAX_MESSAGE_LOG = 50;
// Lifetime count of flagged checks — unlike messageLog this is never trimmed,
// so it stays accurate even after old log entries age out.
const STRIKE_COUNT_KEY = 'strikeCount';
// A cursor into watch history: the lastVisitTime of the newest video already
// considered by a completed check. queryYoutubeHistory() never re-includes
// videos at or before this point, so a video is never reclassified (or
// re-alerted on). Only advances once a check completes successfully (see the
// end of checkYoutubeHistory()), so a transient failure mid-check gets
// retried from the same point next time rather than silently skipping those
// videos forever.
const LAST_PROCESSED_VISIT_KEY = 'lastProcessedVisitTime';
// Cached { instruction, question } from watch.parseIntentResponse() —
// regenerated only when the instruction text changes, so the LLM
// intent-extraction call doesn't run on every check.
const INTENT_KEY = 'jevIntent';

// Proactive path: alongside the manual "Check now" button, a recurring alarm
// runs the same two-step cascade unattended and fires an OS notification when
// it flags something, so a doomscrolling session actually gets interrupted
// instead of only being visible if the user happens to open the popup.
const CHECK_ALARM_NAME = 'alux-periodic-check';
const CHECK_INTERVAL_MINUTES = 5;
// Used as the alarm's schedule, and as the width of the watch-history window
// itself — see checkYoutubeHistory()'s call to queryYoutubeHistory(), which
// windows around the last video actually watched, not around Date.now().
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

chrome.runtime.onInstalled.addListener(ensurePeriodicCheckAlarm);
chrome.runtime.onStartup.addListener(ensurePeriodicCheckAlarm);
// Also run on every service worker (re)start — e.g. reloading the unpacked
// extension — so an interval change here takes effect without relying on
// onInstalled firing.
ensurePeriodicCheckAlarm();

// chrome.alarms.create() always cancels and reschedules an existing alarm of
// the same name, resetting its countdown to `periodInMinutes` from *now*. The
// service worker restarts often (it's suspended after ~30s idle and woken by
// any message, popup open, etc.), so calling create() unconditionally on every
// restart would keep pushing the alarm back and it might never actually fire.
// Only (re)create it when it's missing or scheduled with a stale interval.
async function ensurePeriodicCheckAlarm() {
  const existing = await chrome.alarms.get(CHECK_ALARM_NAME);
  if (existing && existing.periodInMinutes === CHECK_INTERVAL_MINUTES) return;
  chrome.alarms.create(CHECK_ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM_NAME) runPeriodicCheck();
});

// Runs the same cascade as "Check now", but unattended: errors (not
// connected, no instruction set, no recent history) are expected in this
// path and simply mean "nothing to do yet", not a failure to surface.
//
// "Alerted" here means pause + spoken note delivered. Since this path has no
// popup open to play audio in, the note is spoken directly in the YouTube tab
// via lib/content-pause.js instead. Only once that's done (or at least
// attempted) does the strike get recorded and the message cleared — see
// finalizeAlert().
//
// The check itself always runs (cheap, and keeps the reaction-tracking
// history in lib/reflection.js up to date), but the actual interruption is
// skipped if the user isn't currently on YouTube — pausing/speaking/notifying
// about a session they already left is just noise, and the insight stays
// stored (uncleared, strike not recorded) so it can still surface later.
async function runPeriodicCheck() {
  let insight;
  try {
    insight = await checkYoutubeHistory();
  } catch {
    return;
  }

  if (!insight.flagged) return;
  if (!(await isUserOnYoutube())) return;

  await pauseYoutubeVideos();

  let audioUrl = null;
  try {
    audioUrl = await speakText(insight.text);
  } catch (err) {
    console.warn('Alux: TTS failed for periodic alert, notifying without voice:', err.message);
  }
  if (audioUrl) await playAudioInYoutubeTabs(audioUrl);

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Alux',
    message: insight.text
  });

  await directToYoutubeSearch(insight.searchQuery);
  await finalizeAlert();
}

// True if the tab the user is actually looking at right now (the active tab
// in the last-focused window) is a YouTube tab — as opposed to merely having
// one open in the background. That's the bar for "worth interrupting".
async function isUserOnYoutube() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: '*://*.youtube.com/*'
  });
  return Boolean(activeTab);
}

// Pauses any currently-playing <video> in open YouTube tabs, via the content
// script in lib/content-pause.js. Best-effort: a tab may not have the content
// script loaded yet (e.g. opened before the extension was installed/reloaded —
// content scripts don't retroactively attach to already-open tabs), so
// individual sendMessage failures don't stop the alert/note, just get logged.
async function pauseYoutubeVideos() {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  if (tabs.length === 0) {
    console.warn('Alux: no open YouTube tabs found to pause.');
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO' }).catch((err) => {
        console.warn(`Alux: could not pause tab ${tab.id} (${tab.url}):`, err.message);
      })
    )
  );
}

// Plays the given TTS audio (a data: URL) directly in each open YouTube tab,
// via lib/content-pause.js — used for the periodic alert, which has no popup
// open to play audio in itself.
async function playAudioInYoutubeTabs(audioUrl) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: 'PLAY_AUDIO', audioUrl }).catch((err) => {
        console.warn(`Alux: could not play audio in tab ${tab.id} (${tab.url}):`, err.message);
      })
    )
  );
}

// Navigates the user straight to the suggested alternative: a YouTube search
// for the model's `search_query` (see buildWriteupMessages/parseWriteupResponse
// in lib/watch.js). Prefers replacing the video the user was just watching
// (the active YouTube tab, if any) over opening a redundant new one; falls
// back to a new tab if no YouTube tab is open at all. No-ops if the model
// didn't return a usable search query.
async function directToYoutubeSearch(searchQuery) {
  if (!searchQuery) return;

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });

  if (tabs.length === 0) {
    await chrome.tabs.create({ url: searchUrl });
    return;
  }

  const targetTab = tabs.find((tab) => tab.active) || tabs[0];
  await chrome.tabs.update(targetTab.id, { url: searchUrl });
}

// Marks a flagged note as delivered: records the strike (lifetime count,
// never trimmed) and clears the stored insight, since the message has now
// been paused-for and spoken — it shouldn't linger as a stale reminder next
// time the popup opens. Called once alerting (pause + voice) has happened,
// from both the periodic path above and the manual "Check now" path (via the
// ALERT_DELIVERED message from popup.js after it plays the note).
async function finalizeAlert() {
  const stored = await chrome.storage.local.get(STRIKE_COUNT_KEY);
  const strikeCount = (stored[STRIKE_COUNT_KEY] || 0) + 1;
  await chrome.storage.local.set({ [STRIKE_COUNT_KEY]: strikeCount, [INSIGHT_KEY]: null });
  return strikeCount;
}

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
      setWatchSettings(message.instruction, message.ttsVoice).then(sendResponse);
      return true;
    case 'CHECK_YOUTUBE_HISTORY':
      checkYoutubeHistory()
        .then((insight) => sendResponse({ ok: true, insight }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case 'SPEAK_TEXT':
      speakText(message.text)
        .then((audioUrl) => sendResponse({ ok: true, audioUrl }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case 'ALERT_DELIVERED':
      directToYoutubeSearch(message.searchQuery)
        .then(() => finalizeAlert())
        .then((strikeCount) => sendResponse({ ok: true, strikeCount }));
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
  const stored = await chrome.storage.local.get([INSTRUCTION_KEY, TTS_VOICE_KEY, INSIGHT_KEY, STRIKE_COUNT_KEY]);
  return {
    instruction: stored[INSTRUCTION_KEY] || '',
    ttsVoice: stored[TTS_VOICE_KEY] || openrouter.DEFAULT_TTS_VOICE,
    insight: stored[INSIGHT_KEY] || null,
    strikeCount: stored[STRIKE_COUNT_KEY] || 0
  };
}

// writeupModel/ttsModel are plugin config, not user-facing — set directly in
// chrome.storage.local (e.g. by an admin/dev tool), never through the popup UI.
// ttsVoice is the one user-friendly knob, exposed via the popup's voice picker.
//
// Also eagerly extracts/caches the Jev intent (subject + criteria) for the
// saved instruction right away, via getOrExtractIntent() below, instead of
// waiting for the first check to need it — so by the time a check actually
// runs, classification is ready to go immediately. If extraction fails here
// (network hiccup, not connected yet) it's not fatal: the instruction still
// saves, and checkYoutubeHistory() will retry extraction lazily on its own.
async function setWatchSettings(instruction, ttsVoice) {
  const trimmedInstruction = (instruction || '').trim();
  await chrome.storage.local.set({
    [INSTRUCTION_KEY]: trimmedInstruction,
    [TTS_VOICE_KEY]: (ttsVoice || '').trim()
  });

  if (trimmedInstruction) {
    const stored = await chrome.storage.local.get([STORAGE_KEY, WRITEUP_MODEL_KEY]);
    const apiKey = stored[STORAGE_KEY];
    if (apiKey) {
      const writeupModel = (stored[WRITEUP_MODEL_KEY] || '').trim() || openrouter.DEFAULT_WRITEUP_MODEL;
      try {
        await getOrExtractIntent(apiKey, trimmedInstruction, writeupModel);
      } catch (err) {
        console.warn('Alux: intent extraction on save failed, will retry on next check:', err.message);
      }
    }
  }

  return { ok: true };
}

// Reuses the cached intent if the instruction hasn't changed since it was
// last extracted; otherwise calls the writeup model to derive a fresh one
// (see watch.buildIntentExtractionMessages/parseIntentResponse) and caches it.
async function getOrExtractIntent(apiKey, instruction, model) {
  const stored = await chrome.storage.local.get(INTENT_KEY);
  const cached = stored[INTENT_KEY];
  if (cached && cached.instruction === instruction) return cached;

  const raw = await openrouter.sendChatMessage(apiKey, watch.buildIntentExtractionMessages(instruction), model);
  const intent = { instruction, ...watch.parseIntentResponse(raw, instruction) };
  await chrome.storage.local.set({ [INTENT_KEY]: intent });
  return intent;
}

// Cascade, run either by clicking "Check now" or by the periodic alarm (see
// runPeriodicCheck above):
// 0. Extract (or reuse a cached) intent from the user's free-text
//    instruction — a single precise TRUE/FALSE question describing the
//    content — via a normal chat model, since Jev only answers pre-built
//    typed questions. See getOrExtractIntent / lib/watch.js buildIntentExtractionMessages.
// 1. Best-effort enrich each history entry with description/channel name
//    (lib/videoinfo.js — unofficial page scrape, empty strings on failure),
//    then ask Jev to answer that question individually for each video in one
//    call — see lib/watch.js buildJevDecisionRequest / classifyEntries.
// 2. Flagging is derived directly from the resulting match rate (no separate
//    "is this worth mentioning" gate) against FLAG_THRESHOLD.
// 3. Compare this check's match rate against the message log to see how the
//    user reacted since the last note (lib/reflection.js) — did they cut
//    back, ignore it, or cut back and then relapse?
// 4. Only if flagged, ask a normal chat model to write the actual note
//    (tailored by that reaction), since Jev itself never returns prose.
// 5. Persist the per-video classifications and this message to their logs,
//    so future checks have history to react to.
async function checkYoutubeHistory() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY,
    INSTRUCTION_KEY,
    WRITEUP_MODEL_KEY,
    LAST_PROCESSED_VISIT_KEY
  ]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');

  const instruction = (stored[INSTRUCTION_KEY] || '').trim();
  if (!instruction) throw new Error('Tell Alux what to watch for first.');

  const writeupModel = (stored[WRITEUP_MODEL_KEY] || '').trim() || openrouter.DEFAULT_WRITEUP_MODEL;

  // Window is anchored to the last video actually watched, not to Date.now()
  // — see queryYoutubeHistory()'s doc comment. sinceTimestamp here is purely
  // the "don't reprocess" cursor (0 for the very first check ever), not a
  // lookback duration.
  const sinceTimestamp = stored[LAST_PROCESSED_VISIT_KEY] || 0;

  let entries = await watch.queryYoutubeHistory(CHECK_INTERVAL_MS, sinceTimestamp);
  if (entries.length === 0) {
    throw new Error('No new YouTube watch history since your last check.');
  }
  entries = await videoinfo.enrichEntriesWithPageInfo(entries);

  const intent = await getOrExtractIntent(apiKey, instruction, writeupModel);

  const decisionRequest = watch.buildJevDecisionRequest(entries, intent);
  const answers = await openrouter.askJevDecision(apiKey, decisionRequest);

  const classifications = watch.classifyEntries(entries, answers);
  const currentMatchRate = watch.matchRate(classifications);
  const confidence = currentMatchRate;
  const flagged = currentMatchRate > watch.FLAG_THRESHOLD;

  const { messageLog } = await getLogs();
  const { reaction, note: reactionNote } = reflection.describeReaction(messageLog, currentMatchRate);

  let text = "Alux checked — nothing in your recent YouTube history matched what you asked it to watch for.";
  let searchQuery = null;
  if (flagged) {
    const raw = await openrouter.sendChatMessage(
      apiKey,
      watch.buildWriteupMessages(instruction, entries, reactionNote, intent),
      writeupModel,
      { responseFormat: 'json_object' }
    );
    ({ message: text, searchQuery } = watch.parseWriteupResponse(raw));
  }

  const at = Date.now();
  // Strike + clearing the message + the auto-redirect happen later, once the
  // alert is actually delivered (pause + voice) — see finalizeAlert() and
  // directToYoutubeSearch().
  const insight = { text, searchQuery, at, flagged, confidence, matchRate: currentMatchRate, reaction };
  await chrome.storage.local.set({ [INSIGHT_KEY]: insight });
  await appendLogs({
    classifications,
    message: { at, flagged, matchRate: currentMatchRate, confidence, instruction, reaction }
  });

  // Only advance the cursor once the check has fully succeeded — if
  // something above threw (e.g. a transient API error), the next check
  // retries from the same point instead of silently skipping these videos.
  const newestVisit = Math.max(...entries.map((e) => e.lastVisitTime));
  await chrome.storage.local.set({ [LAST_PROCESSED_VISIT_KEY]: newestVisit });
  return insight;
}

async function getLogs() {
  const stored = await chrome.storage.local.get([VIDEO_LOG_KEY, MESSAGE_LOG_KEY]);
  return {
    videoLog: stored[VIDEO_LOG_KEY] || [],
    messageLog: stored[MESSAGE_LOG_KEY] || []
  };
}

async function appendLogs({ classifications, message }) {
  const { videoLog, messageLog } = await getLogs();
  await chrome.storage.local.set({
    [VIDEO_LOG_KEY]: [...videoLog, ...classifications].slice(-MAX_VIDEO_LOG),
    [MESSAGE_LOG_KEY]: [...messageLog, message].slice(-MAX_MESSAGE_LOG)
  });
}

// ttsModel is plugin config, not user-facing — same pattern as writeupModel,
// set directly in chrome.storage.local. ttsVoice is user-facing via the popup.
async function speakText(text) {
  const stored = await chrome.storage.local.get([STORAGE_KEY, TTS_MODEL_KEY, TTS_VOICE_KEY]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');
  if (!text) throw new Error('Nothing to speak.');

  const ttsModel = (stored[TTS_MODEL_KEY] || '').trim() || openrouter.DEFAULT_TTS_MODEL;
  const ttsVoice = (stored[TTS_VOICE_KEY] || '').trim() || openrouter.DEFAULT_TTS_VOICE;

  await pauseYoutubeVideos();
  const audioBuffer = await openrouter.synthesizeSpeech(apiKey, text, ttsModel, ttsVoice);
  return `data:audio/mpeg;base64,${arrayBufferToBase64(audioBuffer)}`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
