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

// Pulls YouTube *watch* and *Shorts* visits from the browser's history that
// happened strictly after `sinceTimestamp` (one entry per video, sorted
// most-recent-first). This only sees what chrome.history already has, i.e.
// the same YouTube activity the browser itself recorded.
//
// `sinceTimestamp` is an absolute cursor — "everything already considered by
// a previous check, up to this point in the history's own timeline" — not a
// clock-time duration like "the last 5 minutes." That distinction matters:
// a duration measured from Date.now() drifts out of sync with when the user
// actually watched something (confusing right after loading the extension,
// or after any gap since the last check), whereas a cursor into the history
// itself doesn't care how much real time has passed. background.js owns
// picking/advancing this cursor (see LAST_PROCESSED_VISIT_KEY).
//
// Each entry carries `visitCount`: how many times *after the cursor* that
// video was watched. This deliberately does NOT use HistoryItem.visitCount
// from chrome.history.search — that field is a lifetime total across all of
// history, not scoped to the cursor, so it would conflate "watched 5 times
// just now" with "watched 5 times, spread over months." Instead, each
// underlying URL's individual visits are pulled via chrome.history.getVisits()
// and filtered down to ones after the cursor, so the count reflects actual
// rewatching since it last advanced.
export async function queryYoutubeHistory(sinceTimestamp) {
  const results = await chrome.history.search({ text: 'youtube.com', startTime: sinceTimestamp, maxResults: 1000 });

  const byVideoId = new Map();
  const urlsByVideoId = new Map();
  for (const item of results) {
    if (!item.url || !item.title) continue;

    const lastVisitTime = item.lastVisitTime || 0;
    if (lastVisitTime <= sinceTimestamp) continue; // strictly after the cursor only

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
// values — no prose. There's no separate "is this worth mentioning" gate
// anymore: flagging is derived directly from the fraction of videos Jev
// classifies as matching the extracted subject (see matchRate below) against
// this threshold, so it's tied to the same intent-driven criteria as the
// per-video questions themselves.
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

// One "choice" question per video ID: Jev picks between the extracted
// subject (e.g. FOOD) and its negation (NOT_FOOD), rather than a vague
// "does this match" noul — see buildIntentExtractionMessages/parseIntentResponse
// below for how `intent` gets derived from the user's free-text instruction.
// `entries` are expected to already carry `description`/`channelTitle` from
// lib/videoinfo.js's enrichEntriesWithPageInfo() (empty strings if that
// best-effort fetch failed for a given video — Jev still gets id/title/type).
export function buildJevDecisionRequest(instruction, entries, intent) {
  const { subject, trueCriteria, falseCriteria } = intent;
  const negativeLabel = `NOT_${subject}`;

  const questions = {};
  for (const entry of entries) {
    questions[videoClassificationQuestionKey(entry.videoId)] = {
      type: 'choice',
      instructions:
        `Is ${subject} the primary subject of the watch history entry with id "${entry.videoId}"? ` +
        `Return ${subject} if the video is primarily about: ${trueCriteria}. Return ${negativeLabel} if ` +
        `${subject.toLowerCase()} is only incidental to a broader topic: ${falseCriteria}`,
      criteria: {
        [subject]: trueCriteria,
        [negativeLabel]: falseCriteria
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
        last_watched: formatRelativeTime(e.lastVisitTime),
        watch_count_in_window: e.visitCount || 1,
        description: e.description || '',
        channel_title: e.channelTitle || ''
      }))
    },
    questions
  };
}

// Reads back the per-video choice answers built above into plain
// classification records, ready for background.js to append to its
// persistent log. `matched` is true when Jev's choice equals the subject
// itself (e.g. "FOOD"), not the negation.
export function classifyEntries(entries, answers, subject) {
  return entries.map((entry) => {
    const answer = answers?.[videoClassificationQuestionKey(entry.videoId)];
    return {
      videoId: entry.videoId,
      title: entry.title,
      isShort: entry.isShort,
      lastVisitTime: entry.lastVisitTime,
      visitCount: entry.visitCount || 1,
      classifiedAt: Date.now(),
      confidence: answer?.confidence ?? 0,
      matched: answer?.choice === subject
    };
  });
}

// Step 0: turns the user's free-text instruction (e.g. "Alert me if I'm
// doomscrolling food videos") into a concrete content-category label plus
// true/false classification criteria, via a normal chat model — Jev itself
// only answers pre-built typed questions, it can't do this extraction.
// Cached by background.js (keyed on the instruction text) since the
// instruction rarely changes and re-deriving it on every check would waste
// a call.
export function buildIntentExtractionMessages(instruction) {
  return [
    {
      role: 'system',
      content:
        'Extract a single "primary content subject" from a user\'s doomscrolling-alert instruction, ' +
        'plus classification criteria for it, so a downstream classifier can judge whether that subject ' +
        'is the PRIMARY topic of a given video (as opposed to merely mentioned in passing). Respond with ' +
        'ONLY a JSON object of the form {"subject": "...", "true_criteria": "...", "false_criteria": "..."}. ' +
        '"subject" must be a short 1-3 word label in UPPER_SNAKE_CASE naming the CONTENT category the user ' +
        'wants flagged (e.g. FOOD, GAMING, TRUE_CRIME) — not the behavior itself (never "DOOMSCROLLING"). ' +
        '"true_criteria" is a semicolon-separated list of 4-6 specific things that count as primarily about ' +
        'that subject. "false_criteria" describes when the subject is merely incidental to a different ' +
        'broader topic, naming 3-5 example other topics. Example, for the instruction "Alert me if I am ' +
        'doomscrolling youtube watching food videos.": {"subject": "FOOD", "true_criteria": "cooking or ' +
        'recipes; eating or tasting food; restaurants or food reviews; ingredients or culinary techniques; ' +
        'food preparation; food-focused education", "false_criteria": "food is only incidental to a broader ' +
        'topic, such as travel, lifestyle, comedy, gaming, news, etc."}'
    },
    { role: 'user', content: `Instruction: "${instruction}"` }
  ];
}

// Sanitizes/validates the model's JSON into a safe intent object — `subject`
// gets used as both a prompt fragment and a literal Jev criteria key, so it's
// constrained to a short uppercase identifier. Falls back to a generic
// "MATCH" subject (criteria built from the raw instruction) if the model
// didn't return usable JSON, so the whole feature degrades gracefully rather
// than breaking checks.
export function parseIntentResponse(raw, instruction) {
  try {
    const parsed = JSON.parse(raw);
    const subject = String(parsed.subject || '')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 30);
    if (subject && typeof parsed.true_criteria === 'string' && typeof parsed.false_criteria === 'string') {
      return { subject, trueCriteria: parsed.true_criteria, falseCriteria: parsed.false_criteria };
    }
  } catch {
    // fall through to the generic fallback below
  }
  return {
    subject: 'MATCH',
    trueCriteria: `the video matches what the user described: "${instruction}"`,
    falseCriteria: "the video does not match what the user described"
  };
}

export function matchRate(classifications) {
  if (classifications.length === 0) return 0;
  const matched = classifications.filter((c) => c.matched).length;
  return matched / classifications.length;
}

// A human-readable form of an UPPER_SNAKE_CASE subject label, for use inside
// a prose prompt — "TRUE_CRIME" -> "true crime".
function humanizeSubject(subject) {
  return subject.toLowerCase().replace(/_/g, ' ');
}

// Step 2 of the cascade: only called when Jev's confidence crosses
// FLAG_THRESHOLD. Runs against a normal chat-completions model (see
// DEFAULT_WRITEUP_MODEL in lib/openrouter.js) since Jev itself can't write text.
// `reactionNote`, when present, comes from lib/reflection.js and tailors the
// tone to how the user has responded to previous notes (e.g. reward them for
// past progress instead of repeating the same nudge every time). `intent`
// (from getOrExtractIntent/parseIntentResponse) drives which specific
// subject the suggested alternative must avoid — it's whatever content
// category was actually extracted from the user's instruction (FOOD,
// GAMING, TRUE_CRIME, ...), not a hardcoded one.
//
// Requests JSON (via response_format in sendChatMessage) with a `message` and
// a `search_query`, so background.js can automatically open a YouTube search
// for the suggested alternative once the alert is delivered — see
// parseWriteupResponse() below and directToYoutubeSearch() in background.js.
export function buildWriteupMessages(instruction, entries, reactionNote, intent) {
  const historyList = historyLines(entries)
    .map((line) => `- ${line}`)
    .join('\n');

  const subjectBan = intent
    ? `never anything primarily about ${humanizeSubject(intent.subject)} in ANY form (${intent.trueCriteria}), ` +
      'even dressed up as educational or aspirational — the point is to break the pattern, not feed it a ' +
      'fancier version of the same thing'
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
