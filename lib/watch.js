// Turns chrome.history entries into a prompt Alux can reflect on.
// Read either on demand (the user clicks "Check now") or on background.js's
// periodic alarm — see runPeriodicCheck in background.js.

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

// Pulls YouTube *watch* and *Shorts* visits straight from the browser's
// history, one calendar day at a time, for the past HISTORY_DAYS days —
// returns an array of { date: 'YYYY-MM-DD', entries: [...] }, most recent
// day first. Querying day-by-day (rather than one flat 30-day search) is
// what lets checkYoutubeHistory() in background.js compute a match rate —
// and award a strike — per calendar day, instead of per arbitrary batch of
// videos.
//
// Within each day: no cursor, no de-duplication of repeat visits to the
// same video — whatever chrome.history.search finds for that day is what
// gets returned, one entry per matching history item. RAW_SEARCH_LIMIT is a
// generous per-day technical ceiling on the raw (pre-filtering) search, not
// a business cap — most youtube.com history hits aren't actual videos
// (homepage visits, search-results pages, channel pages), so it has to ask
// for well more than any real day's video count to avoid losing real videos
// to non-video noise.
//
// parseYoutubeUrl() below is not a "cleanup" filter — it's what turns a
// history item's URL into a video ID at all. Without one there's no way to
// key a per-video question for Jev, so a non-video youtube.com URL is
// structurally unusable here, not excluded as a matter of choice.
const RAW_SEARCH_LIMIT = 5000;
export const HISTORY_DAYS = 30;

function startOfDay(timestamp) {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function queryYoutubeHistory() {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const days = [];

  for (let i = 0; i < HISTORY_DAYS; i++) {
    const dayStart = todayStart - i * 24 * 60 * 60 * 1000;
    const dayEnd = i === 0 ? now : dayStart + 24 * 60 * 60 * 1000; // today is partial, up to now
    const date = new Date(dayStart).toISOString().slice(0, 10);

    const results = await chrome.history.search({
      text: 'youtube.com',
      startTime: dayStart,
      endTime: dayEnd,
      maxResults: RAW_SEARCH_LIMIT
    });

    const entries = [];
    for (const item of results) {
      if (!item.url || !item.title) continue;
      const parsed = parseYoutubeUrl(item.url);
      if (!parsed) continue;
      entries.push({
        videoId: parsed.videoId,
        isShort: parsed.isShort,
        title: item.title,
        lastVisitTime: item.lastVisitTime || 0,
        visitCount: item.visitCount || 1
      });
    }

    console.log(`[Alux] queryYoutubeHistory: ${date} — rawResults=${results.length}, ${entries.length} video entries.`);
    days.push({ date, entries });
  }

  return days;
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
// values — no prose. This is the per-video bar: how confident Jev must be
// for one video to count as "matched" (see classifyEntries below) — a
// deliberately high bar, so a video only counts when Jev is quite sure, not
// just leaning yes. It feeds into each day's match rate, which in turn feeds
// the strike threshold — flagging/interruption is now driven by strikes
// (see checkYoutubeHistory() in background.js), not by comparing an
// aggregate match rate against this constant directly.
export const FLAG_THRESHOLD = 0.8;

// Default per-day bar for strike-counting, used until the user picks a
// different one via the popup's strike-threshold slider (25%/50%/75% — see
// checkYoutubeHistory() in background.js, which reads the stored
// preference and falls back to this default). Any day whose match rate
// exceeds the threshold earns one strike (so at most HISTORY_DAYS strikes
// per check), and strikes (not an aggregate match rate) are what gate the
// pause/voice/redirect interruption.
export const DEFAULT_STRIKE_THRESHOLD = 0.5;

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

// Splits an array into consecutive chunks of at most `size` items each. Used
// to keep each Jev decision request to a bounded number of videos, since
// queryYoutubeHistory() itself no longer caps how many it returns — see
// checkYoutubeHistory() in background.js, which calls Jev once per chunk and
// merges the answers back together.
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
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

// Reads back the per-video noul answers built above into a minimal binary
// classification, ready for background.js to append to its persistent log.
// `matched` is true only when Jev's confidence for that video's question is
// strictly above FLAG_THRESHOLD (0.8) — a deliberately high bar, the same
// one used for the aggregate flagging decision, so a video only counts as a
// "match" when Jev is quite sure, not just leaning yes.
export function classifyEntries(entries, answers) {
  return entries.map((entry) => {
    const confidence = answers?.[videoClassificationQuestionKey(entry.videoId)]?.noul ?? 0;
    return {
      videoId: entry.videoId,
      matched: confidence > FLAG_THRESHOLD
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
// used to classify videos, not a hardcoded category. `strikeCount` (the
// lifetime total, including any earned by this very check — see
// checkYoutubeHistory() in background.js) lets the tone escalate with a
// pattern that keeps recurring, instead of every note sounding the same
// regardless of history.
//
// Requests JSON (via response_format in sendChatMessage) with a `message`
// and a `search_query`, which the popup renders as a clickable link to that
// YouTube search for the suggested alternative — see parseWriteupResponse()
// below and renderInsight() in popup.js. There's no automatic navigation.
export function buildWriteupMessages(instruction, entries, reactionNote, intent, strikeCount = 0) {
  const historyList = historyLines(entries)
    .map((line) => `- ${line}`)
    .join('\n');

  const subjectBan = intent?.question
    ? `never anything that would itself answer TRUE to this question: "${intent.question}" — even dressed up ` +
      'as educational or aspirational; the point is to break the pattern, not feed it a fancier version of ' +
      'the same thing'
    : 'never anything that could plausibly feed the same pattern back to them';

  const strikeContext =
    strikeCount > 0
      ? ` The user has ${strikeCount} strike${strikeCount === 1 ? '' : 's'} recorded for this pattern so far — ` +
        'the more strikes, the firmer and more urgent sentence (2) should be about actually switching to the ' +
        'alternative right now, while staying warm rather than scolding.'
      : '';

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
        'sentence that actively encourages them to switch to watching something else right now, naming ' +
        'a specific topic or video worth watching instead, from a completely different category than ' +
        `whatever was flagged (e.g. a hobby, nature, comedy, tech, or personal-growth video) — ` +
        `${subjectBan}. "search_query" must be a short, literal YouTube search phrase (3-6 words, no ` +
        'punctuation) that would actually surface the specific topic/video named in "message" — it will ' +
        'be used to open a real YouTube search for the user, so it must match "message", not the ' +
        'flagged/forbidden category.' +
        (reactionNote ? ` ${reactionNote}` : '') +
        strikeContext
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
