# Testing Alux

This is a runbook, written to be followed by Claude (or anyone) to exercise
Alux end to end and record what happened. It's split into three tiers:

1. **Automated (Node, free, no browser)** — `tests/lib.test.js` exercises the
   pure logic in `lib/*.js` directly (URL parsing, classification math,
   prompt building, reaction logic). No network calls, no `chrome.*` APIs, no
   API key needed. Run this every time.
2. **Automated (Node, costs a few cents)** — the `evals/` pipeline against a
   real OpenRouter key. Optional; only run when you want to confirm the
   actual Jev round-trip still works, since it spends real money.
3. **Browser / UI (needs a real Chrome browser)** — the popup, the background
   service worker, `chrome.history`, and the actual alert flow can't be
   driven from a terminal. This tier lives in its own doc,
   [`UI_TESTING.md`](UI_TESTING.md), written for either a human or an agent
   with real browser/computer control ("computer use") to drive the actual
   extension UI and record what it observed.

Whoever runs this (Claude or a person) should append a dated entry to the
[Results Log](#results-log) at the bottom after each pass — don't overwrite
previous entries, this file is a running history.

## Tier 1: Automated unit tests

```
node tests/lib.test.js
```

Covers, against the real `lib/watch.js` / `lib/reflection.js`:

- `parseYoutubeUrl` — watch URLs, Shorts URLs, `youtu.be` links, non-YouTube
  URLs, channel-only URLs, and malformed input all resolve correctly.
- `formatRelativeTime` — "less than an hour ago" / "Nh ago" / "Nd ago"
  boundaries.
- `matchRate` — empty list and fractional match rate.
- `classifyEntries` — the `confidence >= 0.5` matched threshold, and the
  default-to-unmatched behavior when Jev returns no answer for a video.
- `buildJevDecisionRequest` — the request shape has no `criteria` block and
  no `user_intent` in `state` (the `'noul'` migration), one `noul` question
  per video naming that video's ID.
- `buildIntentExtractionMessages` / `parseIntentResponse` — the instruction
  text round-trips through the prompt; quote-stripping; the fallback
  question when the model returns nothing.
- `buildWriteupMessages` — the write-up prompt bans content matching the
  extracted question (or falls back to a generic ban with no intent), and
  folds in a reaction note when reflection.js supplies one.
- `parseWriteupResponse` — valid-JSON parsing and the raw-text fallback for
  invalid JSON.
- `reflection.describeReaction` — all four reaction labels (`first_message`,
  `no_change`, `improved`, `relapsed_after_improvement`).

Exit code is `0` only if every assertion passed — treat any non-zero exit or
`FAIL:` line as a real regression, not something to wave through.

**Not covered here (needs a browser or a network key — see Tiers 2 & 3):**
`queryYoutubeHistory()` (needs `chrome.history`), and everything in
`lib/openrouter.js` / `lib/videoinfo.js` that makes real HTTP calls.

## Tier 2: Eval pipeline smoke test (optional, costs real money)

Only run this if you want to confirm the actual OpenRouter round-trip still
works end to end (intent extraction + a Jev decision call). Needs a real key
on your own OpenRouter account — costs a small amount, same as normal usage.

```
OPENROUTER_API_KEY=sk-or-... node evals/run.js --url="https://www.youtube.com/watch?v=VIDEO_ID" --intent="Alert me if I am watching too many food videos."
```

**Pass criteria:** the command exits 0, prints the extracted question, the
JSON request sent to Jev, Jev's raw answer, and a final TRUE/FALSE
classification — no thrown errors, no empty/malformed JSON.

## Tier 3: Browser / UI testing

Everything that needs a real Chrome window with the extension loaded (the
popup, the background service worker, `chrome.history`, the actual alert
flow) lives in **[`UI_TESTING.md`](UI_TESTING.md)** instead of here, since
it's substantial enough (and different enough in kind — screenshots, clicks,
a separate DevTools window for service worker logs) to warrant its own doc.
It's written to be run either by a human or by an agent with real
browser/computer control ("computer use"). Run it, then record results in
*that* file's own Results Log, not this one.

## Results Log

Append one entry per run, most recent last. Don't delete old entries.

<!--
Template:
### YYYY-MM-DD HH:MM
- Tier 1: PASS/FAIL (N passed, N failed) — notes
- Tier 2: PASS/FAIL/SKIPPED — notes
- Tier 3: per-section PASS/FAIL/SKIPPED — notes
-->

### 2026-09-20
- Tier 1: PASS (26 passed, 0 failed) — run via `node tests/lib.test.js` right after writing the suite, against the current `lib/watch.js`/`lib/reflection.js` (post `noul` migration, post history-anchor fix).
- Tier 2: not run this pass.
- Tier 3: not run this pass.
