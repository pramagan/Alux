// Turns chrome.history entries into a prompt Alux can reflect on.
// Read either on demand (the user clicks "Check now") or on background.js's
// periodic alarm — see runPeriodicCheck in background.js.

// Fallback only — background.js always passes an explicit lookback matching
// its check interval (see DEFAULT_LOOKBACK_MS usage below), so the same
// videos aren't re-classified and re-alerted on every subsequent check.
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // last 7 days
const MAX_VIDEOS = 50;

// Pulls recent YouTube *watch* and *Shorts* visits from the browser's history,
// de-duped by video id and sorted most-recent-first. This only sees what
// chrome.history already has, i.e. the same YouTube activity the browser
// itself recorded. `lookbackMs` should match the caller's check interval, so
// each check only sees activity since roughly the last one.
export async function queryYoutubeHistory(lookbackMs = DEFAULT_LOOKBACK_MS) {
  const results = await chrome.history.search({
    text: 'youtube.com',
    startTime: Date.now() - lookbackMs,
    maxResults: 1000
  });

  const byVideoId = new Map();
  for (const item of results) {
    if (!item.url || !item.title) continue;

    let url;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (!url.hostname.endsWith('youtube.com')) continue;

    let videoId;
    let isShort = false;
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else if (url.pathname.startsWith('/shorts/')) {
      videoId = url.pathname.slice('/shorts/'.length).split('/')[0];
      isShort = true;
    } else {
      continue;
    }
    if (!videoId) continue;

    const lastVisitTime = item.lastVisitTime || 0;
    const existing = byVideoId.get(videoId);
    if (!existing || lastVisitTime > existing.lastVisitTime) {
      byVideoId.set(videoId, { videoId, title: item.title, lastVisitTime, isShort });
    }
  }

  return Array.from(byVideoId.values())
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
    .slice(0, MAX_VIDEOS);
}

export function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 1) return 'less than an hour ago';
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

// Jev (~typesafe/jev-latest) only answers typed questions and returns typed
// values — no prose. This is step 1 of the cascade: a single cheap "noul"
// (boolean-with-confidence) question asking whether the history is worth
// mentioning at all, gating the more expensive write-up call in step 2.
export const FLAG_THRESHOLD = 0.8;

function historyLines(entries) {
  return entries.map(
    (e) => `${e.title}${e.isShort ? ' [Short]' : ''} — last watched ${formatRelativeTime(e.lastVisitTime)}`
  );
}

// One noul question per video ID, so Jev classifies each video individually
// (not just the history as a whole) — this is what lets background.js build
// a per-video classification log over time, in addition to the aggregate
// should_flag gate below.
function videoClassificationQuestionKey(videoId) {
  return `video_${videoId}`;
}

export function buildJevDecisionRequest(instruction, entries) {
  const questions = {
    should_flag: {
      type: 'noul',
      instructions:
        "The user described what they want watched for in their own YouTube history, and you've " +
        'been given their recent watch history. Decide whether this history matches what they asked ' +
        'to be watched for closely enough to be worth mentioning to them right now.',
      criteria: {
        true: "The recent watch history clearly matches the pattern described in the user's instruction.",
        false: "The recent watch history does not meaningfully match the user's instruction."
      }
    }
  };

  for (const entry of entries) {
    questions[videoClassificationQuestionKey(entry.videoId)] = {
      type: 'noul',
      instructions:
        `Look specifically at the watch history entry with id "${entry.videoId}". Decide whether that ` +
        "single video matches the pattern described in the user's instruction.",
      criteria: {
        true: 'This specific video matches the pattern described in the instruction.',
        false: 'This specific video does not match the pattern described in the instruction.'
      }
    };
  }

  return {
    state: {
      instruction,
      recent_youtube_watches: entries.map((e) => ({
        id: e.videoId,
        title: e.title,
        type: e.isShort ? 'short' : 'video',
        last_watched: formatRelativeTime(e.lastVisitTime)
      }))
    },
    questions
  };
}

// Reads back the per-video noul answers built above into plain classification
// records, ready for background.js to append to its persistent log.
export function classifyEntries(entries, answers) {
  return entries.map((entry) => {
    const confidence = answers?.[videoClassificationQuestionKey(entry.videoId)]?.noul ?? 0;
    return {
      videoId: entry.videoId,
      title: entry.title,
      isShort: entry.isShort,
      lastVisitTime: entry.lastVisitTime,
      classifiedAt: Date.now(),
      confidence,
      matched: confidence >= 0.5
    };
  });
}

export function matchRate(classifications) {
  if (classifications.length === 0) return 0;
  const matched = classifications.filter((c) => c.matched).length;
  return matched / classifications.length;
}

// Step 2 of the cascade: only called when Jev's confidence crosses
// FLAG_THRESHOLD. Runs against a normal chat-completions model (see
// DEFAULT_WRITEUP_MODEL in lib/openrouter.js) since Jev itself can't write text.
// `reactionNote`, when present, comes from lib/reflection.js and tailors the
// tone to how the user has responded to previous notes (e.g. reward them for
// past progress instead of repeating the same nudge every time).
//
// Requests JSON (via response_format in sendChatMessage) with a `message` and
// a `search_query`, so background.js can automatically open a YouTube search
// for the suggested alternative once the alert is delivered — see
// parseWriteupResponse() below and directToYoutubeSearch() in background.js.
export function buildWriteupMessages(instruction, entries, reactionNote) {
  const historyList = historyLines(entries)
    .map((line) => `- ${line}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You are Alux, a small unseen spirit who quietly watches over the user and gently guides ' +
        "them in the right direction. You've been given the user's recent YouTube watch history and " +
        'an instruction describing what they specifically want you to pay attention to. A separate ' +
        'check has already confirmed the history is worth mentioning. Respond with ONLY a JSON object ' +
        'of the form {"message": "...", "search_query": "..."}, no other text. "message" must be ' +
        'exactly two sentences: (1) one warm sentence nudging them to stop doomscrolling, and (2) one ' +
        'sentence suggesting a specific topic or video worth watching instead, from a completely ' +
        'different category than whatever was flagged (e.g. a hobby, nature, comedy, tech, or ' +
        'personal-growth video) — never anything about food, cooking, eating, or restaurants in ANY ' +
        'form (recipes, mukbang, food reviews, "trying" expensive food, etc.), even dressed up as ' +
        "educational or aspirational. If the flagged pattern is itself food-related, this rule matters " +
        'even more, not less — the point is to break the pattern, not feed it a fancier version of the ' +
        'same thing. "search_query" must be a short, literal YouTube search phrase (3-6 words, no ' +
        'punctuation) that would actually surface the specific topic/video named in "message" — it will ' +
        'be used to open a real YouTube search for the user, so it must match "message", not the ' +
        'flagged/forbidden category.' +
        (reactionNote ? ` ${reactionNote}` : '')
    },
    {
      role: 'user',
      content: `What I want you to watch for: "${instruction}"\n\nMy recent YouTube watch history:\n${historyList}`
    }
  ];
}

// Parses the {"message", "search_query"} JSON the model was asked to return.
// Falls back to treating the whole response as the message (with no search
// query, so the auto-redirect is simply skipped) if it isn't valid JSON —
// response_format is a strong hint to the model, not a hard guarantee.
export function parseWriteupResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.message === 'string') {
      return { message: parsed.message, searchQuery: parsed.search_query || null };
    }
  } catch {
    // fall through to the raw-text fallback below
  }
  return { message: raw, searchQuery: null };
}
