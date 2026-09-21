// Plain-Node regression suite for the pure-logic parts of lib/*.js — no test
// framework dependency (matches the project's zero-dependency style), no
// network calls, no chrome.* APIs. Run with: node tests/lib.test.js
//
// This deliberately does NOT cover queryYoutubeHistory() (needs chrome.history)
// or lib/openrouter.js's network functions (need a real API key, cost
// money, and need a real Chrome browser to exercise).
import assert from 'node:assert/strict';
import * as watch from '../lib/watch.js';
import * as reflection from '../lib/reflection.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`      ${err.message}`);
  }
}

// --- parseYoutubeUrl ---------------------------------------------------

test('parseYoutubeUrl: standard watch URL', () => {
  const result = watch.parseYoutubeUrl('https://www.youtube.com/watch?v=abc123XYZ_-');
  assert.deepEqual(result, { videoId: 'abc123XYZ_-', isShort: false });
});

test('parseYoutubeUrl: shorts URL', () => {
  const result = watch.parseYoutubeUrl('https://www.youtube.com/shorts/abc123XYZ_-');
  assert.deepEqual(result, { videoId: 'abc123XYZ_-', isShort: true });
});

test('parseYoutubeUrl: youtu.be short link', () => {
  const result = watch.parseYoutubeUrl('https://youtu.be/abc123XYZ_-');
  assert.deepEqual(result, { videoId: 'abc123XYZ_-', isShort: false });
});

test('parseYoutubeUrl: non-YouTube URL returns null', () => {
  assert.equal(watch.parseYoutubeUrl('https://example.com/watch?v=abc123'), null);
});

test('parseYoutubeUrl: YouTube channel page (no video) returns null', () => {
  assert.equal(watch.parseYoutubeUrl('https://www.youtube.com/channel/UC12345'), null);
});

test('parseYoutubeUrl: malformed URL returns null instead of throwing', () => {
  assert.equal(watch.parseYoutubeUrl('not a url'), null);
});

// --- formatRelativeTime -------------------------------------------------

test('formatRelativeTime: under an hour ago', () => {
  const result = watch.formatRelativeTime(Date.now() - 10 * 60 * 1000);
  assert.equal(result, 'less than an hour ago');
});

test('formatRelativeTime: a few hours ago', () => {
  const result = watch.formatRelativeTime(Date.now() - 3 * 3_600_000);
  assert.equal(result, '3h ago');
});

test('formatRelativeTime: multiple days ago', () => {
  const result = watch.formatRelativeTime(Date.now() - 50 * 3_600_000);
  assert.equal(result, '2d ago');
});

// --- matchRate ------------------------------------------------------------

test('matchRate: empty list is 0', () => {
  assert.equal(watch.matchRate([]), 0);
});

test('matchRate: fraction matched', () => {
  const classifications = [{ matched: true }, { matched: true }, { matched: true }, { matched: false }];
  assert.equal(watch.matchRate(classifications), 0.75);
});

// --- chunk ---------------------------------------------------------------

test('chunk: splits into fixed-size groups with a smaller final chunk', () => {
  const result = watch.chunk([1, 2, 3, 4, 5], 2);
  assert.deepEqual(result, [[1, 2], [3, 4], [5]]);
});

test('chunk: array shorter than size returns one chunk', () => {
  assert.deepEqual(watch.chunk([1, 2], 50), [[1, 2]]);
});

test('chunk: empty array returns no chunks', () => {
  assert.deepEqual(watch.chunk([], 50), []);
});

// --- classifyEntries --------------------------------------------------

test('classifyEntries: confidence > 0.8 matches, at or below does not', () => {
  const entries = [
    { videoId: 'v1', title: 'A', lastVisitTime: Date.now() },
    { videoId: 'v2', title: 'B', lastVisitTime: Date.now() },
    { videoId: 'v3', title: 'C', lastVisitTime: Date.now() }
  ];
  const answers = {
    video_v1: { noul: 0.81 },
    video_v2: { noul: 0.8 },
    video_v3: { noul: 0.5 }
  };
  const result = watch.classifyEntries(entries, answers);
  assert.equal(result[0].matched, true);
  assert.equal(result[1].matched, false);
  assert.equal(result[2].matched, false);
});

test('classifyEntries: returns only videoId and matched, nothing else', () => {
  const entries = [{ videoId: 'v1', title: 'A', isShort: false, lastVisitTime: Date.now(), visitCount: 3 }];
  const result = watch.classifyEntries(entries, { video_v1: { noul: 0.9 } });
  assert.deepEqual(result[0], { videoId: 'v1', matched: true });
});

test('classifyEntries: missing answer defaults to confidence 0 / not matched', () => {
  const entries = [{ videoId: 'v1', title: 'A', lastVisitTime: Date.now() }];
  const result = watch.classifyEntries(entries, {});
  assert.equal(result[0].matched, false);
});

// --- buildJevDecisionRequest -------------------------------------------

test('buildJevDecisionRequest: shape has no criteria/user_intent, one noul question per video', () => {
  const entries = [
    { videoId: 'v1', title: 'Cooking pasta', isShort: false, lastVisitTime: Date.now(), visitCount: 2 }
  ];
  const intent = { question: 'Is this video primarily about food, cooking, eating, restaurants, or food preparation?' };
  const request = watch.buildJevDecisionRequest(entries, intent);

  const json = JSON.stringify(request);
  assert.ok(!json.includes('criteria'), 'request must not contain a criteria block');
  assert.ok(!json.includes('user_intent'), 'request must not contain user_intent in state');

  const q = request.questions['video_v1'];
  assert.equal(q.type, 'noul');
  assert.ok(q.instructions.includes('v1'), 'question must name the video ID');

  const stateEntry = request.state.recent_youtube_watches[0];
  assert.equal(stateEntry.id, 'v1');
  assert.equal(stateEntry.watch_count_in_window, 2);
});

// --- buildIntentExtractionMessages / parseIntentResponse ----------------

test('buildIntentExtractionMessages: embeds the raw instruction', () => {
  const messages = watch.buildIntentExtractionMessages('Alert me if I watch too many food videos.');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.ok(messages[0].content.includes('Alert me if I watch too many food videos.'));
});

test('parseIntentResponse: strips surrounding quotes', () => {
  const result = watch.parseIntentResponse('"Is this video about food?"', 'irrelevant');
  assert.equal(result.question, 'Is this video about food?');
});

test('parseIntentResponse: empty response falls back to a generated question', () => {
  const result = watch.parseIntentResponse('', 'watch too many food videos');
  assert.ok(result.question.includes('watch too many food videos'));
});

// --- buildWriteupMessages -------------------------------------------------

test('buildWriteupMessages: bans content matching the extracted question when intent is present', () => {
  const intent = { question: 'Is this video primarily about food?' };
  const messages = watch.buildWriteupMessages('watch food', [], null, intent);
  assert.ok(messages[0].content.includes('Is this video primarily about food?'));
});

test('buildWriteupMessages: falls back to a generic ban when intent is absent', () => {
  const messages = watch.buildWriteupMessages('watch food', [], null, undefined);
  assert.ok(messages[0].content.includes('could plausibly feed the same pattern back'));
});

test('buildWriteupMessages: folds in a reaction note when provided', () => {
  const messages = watch.buildWriteupMessages('watch food', [], 'Stay warm but be direct.', { question: 'q?' });
  assert.ok(messages[0].content.includes('Stay warm but be direct.'));
});

test('buildWriteupMessages: mentions strike count and escalates tone when > 0', () => {
  const messages = watch.buildWriteupMessages('watch food', [], null, { question: 'q?' }, 3);
  assert.ok(messages[0].content.includes('3 strikes'));
  assert.ok(messages[0].content.includes('firmer and more urgent'));
});

test('buildWriteupMessages: says no strike context at all when strikeCount is 0', () => {
  const messages = watch.buildWriteupMessages('watch food', [], null, { question: 'q?' }, 0);
  assert.ok(!messages[0].content.includes('strike'));
});

// --- parseWriteupResponse -------------------------------------------------

test('parseWriteupResponse: parses valid JSON', () => {
  const result = watch.parseWriteupResponse('{"message": "Take a break!", "search_query": "nature walks"}');
  assert.deepEqual(result, { message: 'Take a break!', searchQuery: 'nature walks' });
});

test('parseWriteupResponse: falls back to raw text on invalid JSON', () => {
  const result = watch.parseWriteupResponse('not json at all');
  assert.deepEqual(result, { message: 'not json at all', searchQuery: null });
});

// --- reflection.describeReaction ----------------------------------------

test('describeReaction: no prior flagged message is "first_message"', () => {
  const result = reflection.describeReaction([], 0.9);
  assert.deepEqual(result, { reaction: 'first_message', note: null });
});

test('describeReaction: sustained high match rate since last flag is "no_change"', () => {
  const messageLog = [{ at: 1000, matchRate: 0.9, flagged: true }];
  const result = reflection.describeReaction(messageLog, 0.85);
  assert.equal(result.reaction, 'no_change');
  assert.ok(result.note);
});

test('describeReaction: dropping well below and staying down is "improved"', () => {
  const messageLog = [{ at: 1000, matchRate: 0.9, flagged: true }];
  const result = reflection.describeReaction(messageLog, 0.1);
  assert.equal(result.reaction, 'improved');
  assert.equal(result.note, null);
});

test('describeReaction: cut back then slipped back up is "relapsed_after_improvement"', () => {
  const messageLog = [
    { at: 1000, matchRate: 0.9, flagged: true },
    { at: 2000, matchRate: 0.1, flagged: false }
  ];
  const result = reflection.describeReaction(messageLog, 0.95);
  assert.equal(result.reaction, 'relapsed_after_improvement');
  assert.ok(result.note);
});

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
