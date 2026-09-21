# UI Testing Alux (browser / computer-use)

A script for an agent with actual browser/computer control (screenshots +
clicks/typing, or a browser-automation tool) to drive the real extension in
a real Chrome window and report what it observed. This is the tier
`TESTING.md` calls "Tier 3" — that file's Tier 1 (`node tests/lib.test.js`)
covers the pure logic and needs no browser at all; this doc is only for the
parts that actually require Chrome.

## Before you start: two gotchas specific to extension popups

1. **The real toolbar popup closes when it loses focus.** Clicking the
   Alux icon in the toolbar opens `popup.html` as a transient popup that
   Chrome automatically closes the instant something else takes focus —
   including, often, the act of taking a screenshot or switching windows to
   read console output. This makes it unreliable for automated
   click-then-screenshot loops.

   **Workaround: open the popup as a normal tab instead.** Its HTML/JS is
   identical either way (`popup.html`/`popup.js` don't know or care whether
   they're in a popup bubble or a tab), so testing it as a tab exercises the
   same code and is far more robust. This extension's `manifest.json` pins a
   fixed `"key"`, so its ID is stable across reloads:

   ```
   chrome-extension://dlkpepejjblcohehdlgkgckaofgaompc/popup.html
   ```

   Verify this ID once at the start of a session: open `chrome://extensions`,
   find the "Alux" card, confirm the ID shown there matches. If it doesn't
   match, use whatever ID is actually shown instead for the rest of this run.

2. **Background service worker logs live in a separate DevTools window**,
   not in the popup tab's console. To see the `[Alux] queryYoutubeHistory: ...`
   diagnostic lines (or any `console.log`/`console.warn` from `background.js`):
   go to `chrome://extensions`, find the Alux card, click the **"service
   worker"** link (shown when the worker is active — if it says "inactive",
   trigger any action first, e.g. open the popup tab, which wakes it). That
   opens a DevTools window whose Console tab has these logs. Screenshot that
   window's console after each action that should produce logs.

## One-time setup

1. Navigate to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle) if it isn't already on.
3. If Alux is not listed: click **"Load unpacked"**, select this repo's root
   directory (`/Users/deepakmaganti/projects/Alux`).
4. If Alux is already listed and you've changed any `.js`/`.html`/`.json`
   file since it was loaded: click the **reload icon** (circular arrow) on
   the Alux card. Chrome does not pick up file edits otherwise — this is the
   single most common reason a fix "doesn't seem to work" during testing.
5. Confirm the extension ID shown on the card, per the gotcha above.
6. Open a new tab at `chrome-extension://<id>/popup.html`. This tab stays
   open like any normal page — use it for the rest of these tests.

## Test scenarios

For each scenario: perform the actions, take a screenshot (or read the DOM
text) at the "Expect" point, and record PASS/FAIL against the stated
criterion in the [Results Log](#results-log).

### UI-1. Connect flow

**Preconditions:** not yet connected (or click "Disconnect" first via the
button at the bottom of the watch-view section to reset to this state).

1. Open the popup tab. **Expect:** the header status pill reads "not
   connected", and the page shows "Connect your OpenRouter account so Alux
   can watch on your behalf..." with a **"Connect OpenRouter account"**
   button (`#connect-btn`). The watch-settings section (textarea,
   Save/Check now buttons) must be hidden.
2. Click **"Connect OpenRouter account"**. This opens OpenRouter's OAuth
   consent screen in a new tab/window — completing it requires a real
   OpenRouter account login, so if no test account is available, stop here
   and record this step as SKIPPED (not FAIL) with that reason.
3. After completing the OAuth consent and returning to the extension:
   **Expect:** the header status pill now reads "connected" (and gets a
   distinguishing style — check `#status.connected` if you can read
   classes), the connect section hides, and the watch-settings section
   (`#watch-view`) becomes visible with the instruction textarea,
   "Save"/"Check now" buttons, and a "Disconnect" link at the bottom. There
   is no voice picker — the spoken note always uses one fixed voice
   (`openrouter.DEFAULT_TTS_VOICE`).

### UI-2. Save an instruction

**Preconditions:** connected (UI-1 done).

1. Click into the instruction textarea (`#instruction-input`), clear it, and
   type: `Alert me if I am watching too many food videos.`
2. Click **"Save"** (`#save-settings-btn`).
3. **Expect:** the button's label briefly changes to "Saved", then reverts
   to "Save" after about a second. There is no visible confirmation of what
   question got extracted from the instruction — that happens silently in
   the background (an eager-cache optimization, see `setWatchSettings()` in
   `background.js`) with nothing shown in the popup UI.
4. Reload the popup tab (navigate to the same URL again).
5. **Expect:** the textarea still contains the exact text you typed — it
   persists in `chrome.storage.local`, not just in-memory.

### UI-3. Strike count is always visible, even at zero

**Preconditions:** a popup opened before any check has run this session (or
right after a check whose most recent batches earned 0 strikes — see UI-5b;
strikes reset every check now, so "0" just means the last check found
nothing, not "never flagged, ever").

1. Look at the header's strike badge (`#strike-count`, next to the status
   pill).
2. **Expect:** it is visible (not `hidden`) and reads exactly `🔥 0 strikes`
   when the count is zero — it must NOT be blank/absent. (This was a bug:
   the badge used to disappear entirely at zero.) If the count is nonzero,
   expect `🔥 N strike` (singular) for N=1 or `🔥 N strikes` (plural)
   otherwise.

### UI-4. Check now — repeated clicks with nothing new watched

**Preconditions:** connected, instruction saved, at least one video watched
on YouTube in this browser profile within the last 30 days (`HISTORY_LOOKBACK_MS`
— anything older than that is now out of range, see below).

1. Open the service worker DevTools console (see gotcha #2 above) so it's
   visible/capturable alongside the popup tab.
2. In the popup tab, click **"Check now"** twice in a row without watching
   anything new on YouTube in between.
3. **Expect (button state):** label changes to "Watching…" and is disabled,
   then reverts to "Check now" and re-enables once the check completes, both
   times.
4. **Expect (popup result):** `#history-error` stays hidden both times —
   **no error text**. `queryYoutubeHistory()` has no cursor and no dedup —
   it returns the raw watch/Shorts history verbatim from the last 30 days,
   capped to the 1000 most recently watched videos within that window, so
   both clicks should classify the same underlying data and produce
   materially the same insight. `#insight` shows "Alux hasn't seen any
   YouTube watches to check yet" if this browser profile has no YouTube
   watch/Shorts visit in the last 30 days at all (not "ever" anymore —
   older history is out of range by design).
5. **Expect (service worker console):** `[Alux] queryYoutubeHistory: rawResults=...`
   followed by `[Alux] queryYoutubeHistory: M video entries found, N kept
   after capping to 1000.` — `N` should be > 0 and identical across both
   clicks, confirming there's no hidden condition causing an empty result.
   `N` will equal `M` unless you have over 1000 distinct video watches in
   this profile's history. Also expect the batching log from
   `checkYoutubeHistory()` (see UI-5) showing how many Jev calls that turned
   into (`ceil(N/50)`).

### UI-5. Check now — after watching something new

**Preconditions:** connected, instruction saved.

1. In a separate tab, watch a real YouTube video to completion (or at least
   long enough to register in browsing history) — ideally one that clearly
   matches your saved instruction, to also exercise the flagged path.
2. Return to the popup tab, click **"Check now"**.
3. **Expect (service worker console):** `rawResults` > 0, and the entry count
   line shows a non-zero count that includes the video you just watched (it
   should be the most recent entry, likely first or near-first in the list).
   Also expect `[Alux] checkYoutubeHistory: classifying N video(s) in K Jev
   call(s).` followed by one `batch i/K done` line per call — with the raw
   history uncapped, `N` can be well over 50, in which case `K` should be
   `ceil(N/50)` (Jev requests are batched at 50 videos per call).
4. **Expect (popup result):** `#insight` becomes visible with new text in
   `#insight-text`, and `#insight-time` reads just `checked <date/time>` —
   no confidence percentage shown anymore.

### UI-5b. Strikes are per-check (reset every time), and drive flagging

**Preconditions:** connected, instruction saved, real watch history present.

Strikes come from `checkYoutubeHistory()`'s per-batch match rates (see UI-5's
batching log) — a batch "earns" a strike when its match rate exceeds 70%
(`STRIKE_MATCH_THRESHOLD`). There is no history kept across checks at all:
`strikeCount` is recomputed from scratch every check and simply overwrites
whatever was stored before, and flagging (which drives the pause/voice/redirect
interruption and the LLM writeup) is `strikeCount > 0` for that check alone.

1. Click "Check now" and watch the service worker console.
2. **Expect:** each `batch i/K done (...)` log line reports that batch's own
   match rate, with `— strike` appended when it exceeded 70%, plus a running
   "Strikes so far this check" count.
3. **Expect:** a line like `[Alux] checkYoutubeHistory: N strike(s) this
   check (aggregate match rate M% across ... video(s)) — flagged=...` where
   `flagged` is `true` iff `N > 0`.
4. **Expect (popup):** the strike badge (`#strike-count`) updates
   immediately after the check completes to exactly `N` — it should not
   require reopening the popup.
5. Click "Check now" again immediately, with nothing new watched. **Expect:**
   the badge shows whatever this new check computed (likely the same `N`,
   since the same history gets re-scored) — it should **not** have added to
   the previous number. If two consecutive checks over unchanged history
   show different totals being summed together, that's a regression.

### UI-6. Flagged alert delivery

**Preconditions:** able to trigger a flagged result (UI-5b with matching
content, i.e. strikeCount > 0 for this check).

1. With a YouTube tab open (so the alert has somewhere to act), trigger a
   flagged "Check now".
2. **Expect:** audio plays (either OpenRouter TTS or the browser's built-in
   voice as fallback — you should hear *something*, or see the "🔊
   Playing…" button state during it), and the YouTube tab's video pauses.
   **There is no automatic navigation** — the YouTube tab must NOT
   change URL on its own. The spoken/written note should reference the
   strike count if it's > 1 (see `buildWriteupMessages`'s strike-escalation
   text).
3. **Expect:** below the note text, a **"🔍 Watch something else instead"**
   link (`#search-link`) is visible whenever `insight.searchQuery` is
   present, pointing to
   `https://www.youtube.com/results?search_query=<the suggested topic>`.
   Clicking it opens that search in a **new tab** (`target="_blank"`) — the
   original YouTube tab is untouched.
4. **Expect:** after delivery, `#insight` (including the link) stays visible
   in the popup — it is deliberately NOT cleared/hidden once delivered, so
   the suggestion remains available for reference/clicking later rather than
   disappearing. The strike badge should **not** change again at this
   point — strikes were already recorded when the check itself completed,
   per UI-5b, not by this delivery step.

### UI-7. Periodic background check (optional, slow)

1. Leave Chrome open and idle (don't touch the popup) for at least an hour
   (`CHECK_INTERVAL_MINUTES`), with the service worker console open.
2. **Expect:** without any manual interaction, the same
   `[Alux] queryYoutubeHistory: ...` diagnostic lines appear automatically
   in the console once the alarm fires, the strike count resets to whatever
   this check computed (per UI-5b) regardless of whether anything gets
   delivered, and if `strikeCount > 0` while you were on a YouTube tab, the
   same pause/voice behavior from UI-6 happens on its own (still no
   automatic navigation — only the popup's link, next time it's opened,
   lets you act on the suggestion).

## Results Log

Append one dated entry per run — don't overwrite previous ones.

<!--
Template:
### YYYY-MM-DD HH:MM
- UI-1 Connect: PASS/FAIL/SKIPPED — notes
- UI-2 Save instruction: PASS/FAIL — notes
- UI-3 Strike count at zero: PASS/FAIL — notes
- UI-4 Check now, repeated clicks: PASS/FAIL — rawResults=..., video count=...
- UI-5 Check now, with new history: PASS/FAIL — notes
- UI-5b Per-check strikes (reset, not cumulative): PASS/FAIL — strikes this check=...
- UI-6 Flagged alert delivery: PASS/FAIL/SKIPPED — notes
- UI-7 Periodic check: PASS/FAIL/SKIPPED — notes
-->
