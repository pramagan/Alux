// Turns chrome.history entries into a prompt Alux can reflect on.
// Read either on demand (the user clicks "Check now") or on background.js's
// periodic alarm — see runPeriodicCheck in background.js.

const MAX_VIDEOS = 50;

// Extracts a video ID (and whether it's a Short) from any YouTube URL form —
// /watch?v=, /shorts/<id>, or a youtu.be/<id> short link. Returns null for
// anything else (not a YouTube URL, or a YouTube URL with no video, like a
// channel or search-results page). Shared by queryYoutubeHistory below and
// by evals/run.js, which has no chrome.history to draw entries from.
export function parseYoutubeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname === 'youtu.be') {
    const videoId = parsed.pathname.slice(1).split('/')[0];
    return videoId ? { videoId, isShort: false } : null;
  }
  if (!parsed.hostname.endsWith('youtube.com')) return null;

  if (parsed.pathname === '/watch') {
    const videoId = parsed.searchParams.get('v');
    return videoId ? { videoId, isShort: false } : null;
  }
  if (parsed.pathname.startsWith('/shorts/')) {
    const videoId = parsed.pathname.slice('/shorts/'.length).split('/')[0];
    return videoId ? { videoId, isShort: true } : null;
  }
  return null;
}

// Pulls YouTube *watch* and *Shorts* visits from the browser's history,
// windowed around the *last video actually watched* — not around Date.now().
// Concretely: find the single most recent YouTube watch (the "anchor"), then
// take everything from `windowMs` before that anchor up through the anchor
// itself. This is deliberately not a clock-time duration like "look back N
// minutes from now" — that drifts out of sync with when the user actually
// watched something (confusing right after loading the extension, or after
// any gap since the last check). Anchoring to the last watch itself means
// the window is always "the last N minutes of watching," regardless of how
// much real time has passed since then.
//
// `sinceTimestamp` (optional, default 0) is a cursor — the lastVisitTime of
// the newest video a previous check already classified — used only to avoid
// re-including videos already processed; it does not affect where the
// window itself is anchored. background.js owns advancing this cursor (see
// LAST_PROCESSED_VISIT_KEY).
//
// Each entry carries `visitCount`: how many times *after the cursor* that
// video was watched. This deliberately does NOT use HistoryItem.visitCount
// from chrome.history.search — that field is a lifetime total across all of
// history, not scoped to the window, so it would conflate "watched 5 times
// just now" with "watched 5 times, spread over months." Instead, each
// underlying URL's individual visits are pulled via chrome.history.getVisits()
// and filtered down to ones after the cursor, so the count reflects actual
// rewatching since it last advanced.
export async function queryYoutubeHistory(windowMs, sinceTimestamp = 0) {
  // Deliberately NOT startTime: sinceTimestamp here. Finding the anchor (the
  // true most recent YouTube watch) and filtering out already-processed
  // videos are two different concerns — conflating them at the query level
  // means that if the cursor ever lands exactly on (or past) the most recent
  // watch, chrome.history.search excludes the very item needed to compute
  // the anchor, and the whole window collapses to empty even though nothing
  // is actually wrong. (chrome.history.search also defaults startTime to
  // "24 hours ago" if omitted entirely, so pass 0 explicitly rather than
  // leaving it out.) Search broadly and unconditionally instead, find the
  // anchor from whatever comes back, and apply sinceTimestamp/window
  // filtering ourselves afterward.
  const results = await chrome.history.search({ text: 'youtube.com', startTime: 0, maxResults: 1000 });

  let anchorTime = 0;
  for (const item of results) {
    if (!item.url || !item.title) continue;
    if (!parseYoutubeUrl(item.url)) continue;
    const t = item.lastVisitTime || 0;
    if (t > anchorTime) anchorTime = t;
  }
  if (anchorTime === 0) {
    console.log(`[Alux] queryYoutubeHistory: 0 results matched a watch/shorts URL (searched ${results.length} raw history items).`);
    return [];
  }

  const windowStart = anchorTime - windowMs;
  console.log(
    `[Alux] queryYoutubeHistory: anchorTime=${new Date(anchorTime).toISOString()}, ` +
      `sinceTimestamp=${sinceTimestamp ? new Date(sinceTimestamp).toISOString() : '(none)'}, ` +
      `windowStart=${new Date(windowStart).toISOString()}, rawResults=${results.length}`
  );

  const byVideoId = new Map();
  const urlsByVideoId = new Map();
  for (const item of results) {
    if (!item.url || !item.title) continue;

    const lastVisitTime = item.lastVisitTime || 0;
    if (lastVisitTime <= sinceTimestamp) continue; // already processed by a previous check
    if (lastVisitTime < windowStart) continue; // outside the window around the last watch

    const parsed = parseYoutubeUrl(item.url);
    if (!parsed) continue;
    const { videoId, isShort } = parsed;

    const existing = byVideoId.get(videoId);
    if (!existing || lastVisitTime > existing.lastVisitTime) {
      byVideoId.set(videoId, { videoId, title: item.title, lastVisitTime, isShort });
    }

    // A video can be reachable via more than one exact URL (different query
    // params, playlist context, etc.) — chrome.history.search returns one
    // HistoryItem per URL, so track every URL that maps to this video id.
    const urls = urlsByVideoId.get(videoId) || [];
    urls.push(item.url);
    urlsByVideoId.set(videoId, urls);
  }

  const entries = Array.from(byVideoId.values());
  console.log(`[Alux] queryYoutubeHistory: ${entries.length} entries after cursor/window filtering.`);
  await Promise.all(
    entries.map(async (entry) => {
      const urls = urlsByVideoId.get(entry.videoId) || [];
      const visitLists = await Promise.all(urls.map((url) => chrome.history.getVisits({ url })));
      const recentVisitCount = visitLists.flat().filter((visit) => (visit.visitTime || 0) > sinceTimestamp).length;
      entry.visitCount = Math.max(recentVisitCount, 1);
    })
  );

  return entries.sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, MAX_VIDEOS);
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
// values — no prose. There's no separate "is this worth mentioning" gate:
// flagging is derived directly from the fraction of videos Jev answers TRUE
// to the extracted question (see matchRate below) against this threshold, so
// it's tied to the same intent-driven question as the per-video questions
// themselves.
export const FLAG_THRESHOLD = 0.8;

function historyLines(entries) {
  return entries.map((e) => {
    const repeatSuffix = e.visitCount > 1 ? ` (watched ${e.visitCount}× in this window)` : '';
    return `${e.title}${e.isShort ? ' [Short]' : ''} — last watched ${formatRelativeTime(e.lastVisitTime)}${repeatSuffix}`;
  });
}

function videoClassificationQuestionKey(videoId) {
  return `video_${videoId}`;
}

// The extracted question is phrased generically ("Is this video primarily
// about..."); for a batch of multiple videos in one request, each question
// needs to name which specific video it's asking about, since `instructions`
// text has no other structural link to state.recent_youtube_watches[i] —
// the `video_<id>` key (matching that entry's `id`) is the identifier tying
// the two together, but the wording is made explicit too for the model.
function questionForVideo(question, videoId) {
  if (/this video/i.test(question)) {
    return question.replace(/this video/i, `the video with ID ${videoId}`);
  }
  return `Regarding the video with ID ${videoId}: ${question}`;
}

// One "noul" (boolean-with-confidence) question per video ID, built from the
// single TRUE/FALSE question extracted above — see buildIntentExtractionMessages/
// parseIntentResponse for how `intent` gets derived from the user's free-text
// instruction. No `criteria` block: the instructions text alone is the
// complete true/false question. `entries` are expected to already carry
// `description`/`channelTitle` from lib/videoinfo.js's
// enrichEntriesWithPageInfo() (empty strings if that best-effort fetch failed
// for a given video — Jev still gets id/title/type).
export function buildJevDecisionRequest(entries, intent) {
  const questions = {};
  for (const entry of entries) {
    questions[videoClassificationQuestionKey(entry.videoId)] = {
      type: 'noul',
      instructions: questionForVideo(intent.question, entry.videoId)
    };
  }

  return {
    state: {
      recent_youtube_watches: entries.map((e) => ({
        id: e.videoId,
        title: e.title,
        type: e.isShort ? 'short' : 'video',
        last_watched: formatRelativeTime(e.lastVisitTime),
        watch_count_in_window: e.visitCount || 1,
        description: e.description || '',
        channel_title: e.channelTitle || ''
      }))
    },
    questions
  };
}

// Reads back the per-video noul answers built above into plain
// classification records, ready for background.js to append to its
// persistent log. `matched` is true when Jev's confidence for that video's
// question is at least 0.5.
export function classifyEntries(entries, answers) {
  return entries.map((entry) => {
    const confidence = answers?.[videoClassificationQuestionKey(entry.videoId)]?.noul ?? 0;
    return {
      videoId: entry.videoId,
      title: entry.title,
      isShort: entry.isShort,
      lastVisitTime: entry.lastVisitTime,
      visitCount: entry.visitCount || 1,
      classifiedAt: Date.now(),
      confidence,
      matched: confidence >= 0.5
    };
  });
}

// Step 0: turns the user's free-text instruction (e.g. "Alert me if I'm
// doomscrolling food videos") into a single precise TRUE/FALSE question
// describing the *content*, stripped of the requested action ("alert me")
// and any behavioral framing ("too many", "doomscrolling") — Jev itself only
// answers pre-built typed questions, it can't do this extraction. Cached by
// background.js (keyed on the instruction text) since the instruction rarely
// changes and re-deriving it on every check would waste a call.
//
// This prompt and its parsing (originally proven out in evals/noul-classifier.js
// against real watch history before being migrated here) ask the model to do
// exactly one thing and return only the bare question — no JSON, no
// explanation.
const INTENT_PROMPT_TEMPLATE = `You are an intent extraction system.

The user will describe something they want to be alerted about or monitor.

Your job is to understand the user's intent and convert it into **one precise TRUE/FALSE question** that captures the content they are referring to.

The question will be answered independently for each piece of content.

Rules:

* Focus only on the user's intended content.
* Ignore the user's requested action, such as "alert me", "notify me", or "tell me".
* Ignore behavioral conditions such as "too many", "too much", "for too long", "doomscrolling", or "keep watching".
* Convert the content the user is referring to into a question that can be answered with TRUE or FALSE.
* The question must describe what the content is about, not what the user is doing.
* Preserve important qualifiers from the user's request.
* Be specific enough to distinguish the requested content from related but different content.
* Do not introduce concepts that the user did not ask about.
* Do not use numerical scores, probabilities, or categories.
* Return only the question. Do not provide an explanation.

Examples:

User:
"Alert me if I'm watching food videos."

Output:
"Is this video primarily about food, cooking, eating, restaurants, or food preparation?"

User:
"Alert me if I'm watching people eat."

Output:
"Is this video primarily about people eating or consuming food?"

User:
"Alert me if I keep watching videos about making desserts."

Output:
"Is this video primarily about preparing or making desserts?"

User:
"Alert me if I'm watching videos about celebrity gossip."

Output:
"Is this video primarily about celebrity gossip or discussion of celebrities' personal lives?"

User:
"Alert me if I'm watching videos where people are arguing."

Output:
"Is interpersonal conflict or arguing between people a primary subject of this video?"

User:
"Alert me if I watch too many videos about cars."

Output:
"Is this video primarily about cars or automobiles?"

Now convert the following user request into one precise TRUE/FALSE question:

{{USER_REQUEST}}`;

export function buildIntentExtractionMessages(instruction) {
  return [{ role: 'user', content: INTENT_PROMPT_TEMPLATE.replace('{{USER_REQUEST}}', instruction) }];
}

// The model is asked to return only the bare question, but may still wrap it
// in quotes (its own examples show quoted Output) — strip those and any
// stray whitespace. Falls back to a generic question if the response is
// somehow empty, so the whole feature degrades gracefully rather than
// breaking checks.
export function parseIntentResponse(raw, instruction) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '')
    .trim();
  return { question: cleaned || `Does this video match what the user described: "${instruction}"?` };
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
// past progress instead of repeating the same nudge every time). `intent`
// (from getOrExtractIntent/parseIntentResponse) drives which specific content
// the suggested alternative must avoid — it's the same TRUE/FALSE question
// used to classify videos, not a hardcoded category.
//
// Requests JSON (via response_format in sendChatMessage) with a `message` and
// a `search_query`, so background.js can automatically open a YouTube search
// for the suggested alternative once the alert is delivered — see
// parseWriteupResponse() below and directToYoutubeSearch() in background.js.
export function buildWriteupMessages(instruction, entries, reactionNote, intent) {
  const historyList = historyLines(entries)
    .map((line) => `- ${line}`)
    .join('\n');

  const subjectBan = intent?.question
    ? `never anything that would itself answer TRUE to this question: "${intent.question}" — even dressed up ` +
      'as educational or aspirational; the point is to break the pattern, not feed it a fancier version of ' +
      'the same thing'
    : 'never anything that could plausibly feed the same pattern back to them';

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
        `different category than whatever was flagged (e.g. a hobby, nature, comedy, tech, or ` +
        `personal-growth video) — ${subjectBan}. "search_query" must be a short, literal YouTube ` +
        'search phrase (3-6 words, no punctuation) that would actually surface the specific topic/video ' +
        'named in "message" — it will be used to open a real YouTube search for the user, so it must ' +
        'match "message", not the flagged/forbidden category.' +
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
