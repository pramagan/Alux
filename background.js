import * as pkce from './lib/pkce.js';
import * as openrouter from './lib/openrouter.js';
import * as watch from './lib/watch.js';
import * as reflection from './lib/reflection.js';
import * as videoinfo from './lib/videoinfo.js';

const STORAGE_KEY = 'openrouterKey';
const INSTRUCTION_KEY = 'watchInstruction';
const WRITEUP_MODEL_KEY = 'writeupModel';
const TTS_MODEL_KEY = 'ttsModel';
const INSIGHT_KEY = 'lastInsight';
// Per-video Jev classifications and past messages, kept so notes can be
// tailored to whether the user actually changed behavior since the last one
// — see lib/reflection.js.
const VIDEO_LOG_KEY = 'videoClassificationLog';
const MESSAGE_LOG_KEY = 'messageLog';
const MAX_VIDEO_LOG = 500;
const MAX_MESSAGE_LOG = 50;
// This check's own strike count. No history kept across checks: every
// "Check now" (or periodic run) recomputes it from scratch and overwrites
// whatever was there before — see checkYoutubeHistory().
const STRIKE_COUNT_KEY = 'strikeCount';
// Cached { instruction, question } from watch.parseIntentResponse() —
// regenerated only when the instruction text changes, so the LLM
// intent-extraction call doesn't run on every check.
const INTENT_KEY = 'jevIntent';
// Max videos sent to Jev in a single decision call — see checkYoutubeHistory()'s
// batching loop.
const JEV_BATCH_SIZE = 50;

// Proactive path: alongside the manual "Check now" button, a recurring alarm
// runs the same two-step cascade unattended and fires an OS notification when
// it flags something, so a doomscrolling session actually gets interrupted
// instead of only being visible if the user happens to open the popup.
const CHECK_ALARM_NAME = 'alux-periodic-check';
const CHECK_INTERVAL_MINUTES = 60;

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

// Runs the same cascade as "Check now", but unattended, on the hourly
// alarm below: errors (not connected, no instruction set) are expected in
// this path and simply mean "nothing to do yet", not a failure to surface.
//
// checkYoutubeHistory() always runs to completion first, which is what
// (re)computes and persists strikeCount — so strikes update on this
// unattended hourly cadence exactly the same as a manual "Check now",
// whether or not the interruption below actually ends up happening.
//
// "Alerted" here means pause + spoken note delivered. Since this path has no
// popup open to play audio in, the note is spoken directly in the YouTube tab
// via lib/content-pause.js instead. The message only gets cleared once
// that's done (or at least attempted) — see finalizeAlert().
//
// The interruption itself is skipped if the user isn't currently on
// YouTube — pausing/speaking/notifying about a session they already left is
// just noise — but the insight stays stored (uncleared) so it can still
// surface later, e.g. next time the popup opens.
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

// Marks a flagged note as delivered. The note/suggestion (including its
// search_query, see buildWriteupMessages/parseWriteupResponse in lib/watch.js)
// stays visible in the popup afterward rather than being cleared or
// auto-navigated to — the user clicks the "watch something else" link
// themselves when they want it (see popup.html/popup.js), there's no
// automatic redirect. Called once alerting (pause + voice) has happened,
// from both the periodic path above and the manual "Check now" path (via
// the ALERT_DELIVERED message from popup.js after it plays the note).
// Strikes are NOT recorded here — see checkYoutubeHistory(), which records
// them per-batch as part of the check itself, independent of whether the
// interruption actually gets delivered.
async function finalizeAlert() {
  const stored = await chrome.storage.local.get(STRIKE_COUNT_KEY);
  const strikeCount = stored[STRIKE_COUNT_KEY] || 0;
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
      setWatchSettings(message.instruction).then(sendResponse);
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
      finalizeAlert().then((strikeCount) => sendResponse({ ok: true, strikeCount }));
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
  const stored = await chrome.storage.local.get([INSTRUCTION_KEY, INSIGHT_KEY, STRIKE_COUNT_KEY]);
  return {
    instruction: stored[INSTRUCTION_KEY] || '',
    insight: stored[INSIGHT_KEY] || null,
    strikeCount: stored[STRIKE_COUNT_KEY] || 0
  };
}

// writeupModel/ttsModel/tts voice are plugin config, not user-facing — set
// directly in chrome.storage.local (e.g. by an admin/dev tool), never
// through the popup UI. The spoken note always uses openrouter.DEFAULT_TTS_VOICE
// (see speakText() below) — there's no per-user voice picker.
//
// Also eagerly extracts/caches the Jev intent (subject + criteria) for the
// saved instruction right away, via getOrExtractIntent() below, instead of
// waiting for the first check to need it — so by the time a check actually
// runs, classification is ready to go immediately. Not surfaced to the popup
// UI, just a warm-cache optimization. If extraction fails here (network
// hiccup, not connected yet) it's not fatal: the instruction still saves,
// and checkYoutubeHistory() will retry extraction lazily on its own.
async function setWatchSettings(instruction) {
  const trimmedInstruction = (instruction || '').trim();
  await chrome.storage.local.set({ [INSTRUCTION_KEY]: trimmedInstruction });

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
//    then ask Jev to answer that question for each video, batched into
//    fixed-size calls — see lib/watch.js buildJevDecisionRequest / chunk /
//    classifyEntries.
// 2. Each batch's own match rate earns a strike if it exceeds
//    STRIKE_MATCH_THRESHOLD; the strike count resets every check (not
//    cumulative) and flagging is simply strikeCount > 0 — no separate
//    aggregate-match-rate gate.
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
    INSIGHT_KEY,
    STRIKE_COUNT_KEY
  ]);
  // No persistent strike history — delete any leftover log from an earlier
  // version of this feature so it can't linger or get read by mistake.
  await chrome.storage.local.remove('strikeLog');
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');

  const instruction = (stored[INSTRUCTION_KEY] || '').trim();
  if (!instruction) throw new Error('Tell Alux what to watch for first.');

  const writeupModel = (stored[WRITEUP_MODEL_KEY] || '').trim() || openrouter.DEFAULT_WRITEUP_MODEL;

  // No window, no cursor, no de-dup — see queryYoutubeHistory()'s doc
  // comment. Every check re-fetches the raw YouTube watch/Shorts history
  // (capped to the 1000 most recent videos), so this only comes back empty
  // if the browser has literally never recorded such a visit. The same
  // video can appear more than once (repeat visits aren't collapsed) and
  // can be reclassified across multiple checks; that's an accepted tradeoff
  // for this being close to the raw data with minimal filtering logic.
  let entries = await watch.queryYoutubeHistory();
  if (entries.length === 0) {
    const strikeCount = stored[STRIKE_COUNT_KEY] || 0;
    if (stored[INSIGHT_KEY]) return { ...stored[INSIGHT_KEY], strikeCount };
    return {
      text: "Alux hasn't seen any YouTube watches to check yet.",
      searchQuery: null,
      at: Date.now(),
      flagged: false,
      confidence: 0,
      matchRate: 0,
      reaction: null,
      strikeCount
    };
  }
  entries = await videoinfo.enrichEntriesWithPageInfo(entries);

  const intent = await getOrExtractIntent(apiKey, instruction, writeupModel);

  // queryYoutubeHistory() no longer caps how many videos it returns, so a
  // single Jev call could carry an unbounded number of them and risk
  // exceeding Jev's context window. Break into fixed-size batches, call Jev
  // once per batch, and merge the answers back into one object keyed the
  // same way classifyEntries() expects (video_<id> -> { noul: confidence }).
  //
  // Strikes are counted per batch: each ~50-video chunk gets its own match
  // rate, and every chunk whose rate exceeds STRIKE_MATCH_THRESHOLD (0.7)
  // adds one strike. A check over the full 1000-video history can therefore
  // earn up to 10 strikes at once — this reflects how much of your whole
  // recent history leaned toward the watched-for content, not just whether
  // the latest chunk did. This total (not the old aggregate match rate) is
  // what now drives both the strike count and the flagged/interruption
  // decision below.
  const batches = watch.chunk(entries, JEV_BATCH_SIZE);
  console.log(`[Alux] checkYoutubeHistory: classifying ${entries.length} video(s) in ${batches.length} Jev call(s).`);
  const answers = {};
  let batchStrikes = 0;
  for (let i = 0; i < batches.length; i++) {
    const decisionRequest = watch.buildJevDecisionRequest(batches[i], intent);
    const batchAnswers = await openrouter.askJevDecision(apiKey, decisionRequest);
    Object.assign(answers, batchAnswers);

    const batchMatchRate = watch.matchRate(watch.classifyEntries(batches[i], batchAnswers));
    const earnedStrike = batchMatchRate > watch.STRIKE_MATCH_THRESHOLD;
    if (earnedStrike) batchStrikes++;
    console.log(
      `[Alux] checkYoutubeHistory: batch ${i + 1}/${batches.length} done (${batches[i].length} videos, ` +
        `match rate ${Math.round(batchMatchRate * 100)}%${earnedStrike ? ' — strike' : ''}). ` +
        `Strikes so far this check: ${batchStrikes}.`
    );
  }

  const classifications = watch.classifyEntries(entries, answers);
  const currentMatchRate = watch.matchRate(classifications);
  const confidence = currentMatchRate;

  // Strike count is recomputed from scratch every check and overwrites
  // whatever was there before — no history, no accumulation.
  // queryYoutubeHistory() has no cursor, so the same history can be
  // re-scored on the very next check; keeping any state across checks on
  // top of that would just inflate or misrepresent the count.
  const strikeCount = batchStrikes;
  await chrome.storage.local.set({ [STRIKE_COUNT_KEY]: strikeCount });

  const flagged = strikeCount > 0;
  console.log(
    `[Alux] checkYoutubeHistory: ${strikeCount} strike(s) this check (aggregate match rate ` +
      `${Math.round(currentMatchRate * 100)}% across ${entries.length} video(s)) — flagged=${flagged}.`
  );

  const { messageLog } = await getLogs();
  const { reaction, note: reactionNote } = reflection.describeReaction(messageLog, currentMatchRate);

  let text = 'Alux checked — no strikes this time; nothing in your recent YouTube history crossed the line.';
  let searchQuery = null;
  if (flagged) {
    const raw = await openrouter.sendChatMessage(
      apiKey,
      watch.buildWriteupMessages(instruction, entries, reactionNote, intent, strikeCount),
      writeupModel,
      { responseFormat: 'json_object' }
    );
    ({ message: text, searchQuery } = watch.parseWriteupResponse(raw));
  }

  const at = Date.now();
  // searchQuery becomes a clickable link in the popup (see renderInsight()
  // in popup.js) — there's no automatic navigation to it.
  const insight = { text, searchQuery, at, flagged, confidence, matchRate: currentMatchRate, reaction };
  await chrome.storage.local.set({ [INSIGHT_KEY]: insight });
  await appendLogs({
    classifications,
    message: { at, flagged, matchRate: currentMatchRate, confidence, instruction, reaction }
  });

  return { ...insight, strikeCount };
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

// ttsModel is plugin config, not user-facing — set directly in
// chrome.storage.local. The voice is always openrouter.DEFAULT_TTS_VOICE —
// no per-user picker, to keep the popup UI simple.
async function speakText(text) {
  const stored = await chrome.storage.local.get([STORAGE_KEY, TTS_MODEL_KEY]);
  const apiKey = stored[STORAGE_KEY];
  if (!apiKey) throw new Error('Not connected to OpenRouter yet.');
  if (!text) throw new Error('Nothing to speak.');

  const ttsModel = (stored[TTS_MODEL_KEY] || '').trim() || openrouter.DEFAULT_TTS_MODEL;

  await pauseYoutubeVideos();
  const audioBuffer = await openrouter.synthesizeSpeech(apiKey, text, ttsModel, openrouter.DEFAULT_TTS_VOICE);
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
