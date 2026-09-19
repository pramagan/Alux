# Alux

*A small, unseen spirit that watches over you and guides you in the right direction.*

A Chrome extension (Manifest V3) that watches your YouTube watch history against an instruction you give it, using [`~typesafe/jev-latest`](https://openrouter.ai/~typesafe/jev-latest) (TypeSafe's "Jev" decision model) on OpenRouter and **each user's own OpenRouter account** — no backend server, no shared API key baked into the extension.

## Why there's no proxy server

A naive build would hardcode an OpenRouter API key in the extension's JS, which anyone can extract from an unpacked `.crx` or DevTools. The usual fix is a backend proxy that holds the key server-side. That's the right call *if you're paying for everyone's usage*.

Here, instead, each user brings their own OpenRouter account and pays for their own usage, via OpenRouter's **OAuth PKCE** flow:

- There is no client secret anywhere in this extension. PKCE (RFC 7636) replaces it with a `code_verifier` that's generated fresh per login and only ever leaves the device once, in the final token-exchange request.
- The flow yields a **per-user API key** scoped to that user's OpenRouter account/credits. If it ever leaked, only that one user is exposed — and they can revoke it from their OpenRouter dashboard.
- Because there's no shared secret, the extension can call OpenRouter directly. No proxy needed.

## How the auth flow works

1. `background.js` generates a `code_verifier` and its SHA-256 `code_challenge` (`lib/pkce.js`).
2. It opens `https://openrouter.ai/auth?...` via `chrome.identity.launchWebAuthFlow`, using the special `https://<extension-id>.chromiumapp.org/` redirect URI Chrome provides for exactly this purpose.
3. OpenRouter redirects back with a one-time `code`.
4. The extension exchanges `{ code, code_verifier }` for an API key by POSTing to `https://openrouter.ai/api/v1/auth/keys` (`lib/openrouter.js`).
5. The resulting key is stored in `chrome.storage.local` (not `.sync`, so it doesn't propagate across the user's other synced Chrome profiles) and used as a normal `Authorization: Bearer` header for every OpenRouter request the extension makes — the decisions call and write-up call in `checkYoutubeHistory()`, plus the TTS call in `speakText()` (see below).

See OpenRouter's docs for the current parameter names: https://openrouter.ai/docs/use-cases/oauth-pkce

## Project layout

```
manifest.json          MV3 manifest — identity + storage + history + alarms + notifications permissions, openrouter.ai + youtube.com host permissions, the pause-video content script
background.js          Service worker: runs the OAuth flow, stores settings, runs the check (on-demand and on a recurring alarm), fires notifications, pauses YouTube before alerting/speaking
lib/pkce.js            PKCE code_verifier / code_challenge generation (Web Crypto)
lib/openrouter.js      OpenRouter endpoint URLs — auth-exchange, chat-completions, the decisions API, and TTS
lib/watch.js           Reads chrome.history for YouTube watches; builds the Jev question(s) + the write-up prompt; per-video classification helpers
lib/reflection.js      Pure logic: compares match-rate history to figure out how the user reacted to past notes
lib/content-pause.js   Content script injected into YouTube tabs; pauses <video> on request from background.js
popup.html/.js/.css    Popup UI: connect button, watch-instruction + voice picker, disconnect button
```

## Running it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project directory.
4. Click the extension icon, then **Connect OpenRouter account** — this opens OpenRouter's authorization page in a popup window.
5. Approve the request. You're returned to the extension, now connected and ready to set a watch instruction.

## Watching your YouTube history

The popup has a free-text box where you tell Alux what to pay attention to in your own YouTube watch history — e.g. *"nudge me if I'm doomscrolling true-crime videos late at night"* or *"tell me if I've been avoiding the coding tutorials I said I'd get through"* — plus a voice picker for how the note gets read aloud. The model Alux uses to write and speak the note is fixed/hidden plugin config (`lib/openrouter.js`), not exposed in the popup.

### Why this is a two-step cascade, not one call

`~typesafe/jev-latest` ("Jev") looked like a normal chat model from its OpenRouter listing, but it isn't one: it's TypeSafe's structured-decision model, served from **`POST https://openrouter.ai/api/alpha/decisions`**, not `/chat/completions`. You send it typed questions (`noul` = boolean-with-confidence, `choice`, or `score`) against a `state` object, and it returns typed answers — a confidence number, a chosen label, a score. There is **no free-text field anywhere in the response**. Calling it through `/chat/completions` (what an earlier version of this extension did) fails with a 400 telling you to use the decisions endpoint instead.

So each check — whether triggered by "Check now" or the periodic alarm — runs up to three calls:

0. **Extract intent from your instruction, when you save it.** Jev only answers pre-built typed questions — it can't interpret free text like *"alert me if I'm doomscrolling food videos"* on its own. `getOrExtractIntent()` in `background.js` sends your instruction to a normal chat model (`watch.buildIntentExtractionMessages()`, JSON response mode) asking it to extract a short content-category **subject** (e.g. `FOOD`) plus `true_criteria`/`false_criteria` describing what counts as primarily about that subject vs. merely incidental to something else — in the same style as: *"Return FOOD if the video is primarily about: cooking or recipes; eating or tasting food; ... Return NOT_FOOD if food is only incidental to a broader topic, such as travel, lifestyle, comedy, gaming, news, etc."* `setWatchSettings()` calls this the moment you click **Save** (not lazily on the first check), so classification is ready to go the instant a check runs; it's cached (`jevIntent` in `chrome.storage.local`, keyed on the instruction text) and only re-derived when you actually change the instruction — `checkYoutubeHistory()` also calls the same function as a fallback in case Save's extraction failed or hasn't run yet (e.g. you weren't connected when you saved).
1. **Jev classifies every video against that subject, in one call.** Each entry first gets best-effort enriched with `description` and `channel_title` (see "Unofficial video-page enrichment" below), then `watch.buildJevDecisionRequest()` builds one **`choice`**-type question per video: *"Is `<subject>` the primary subject of this video?"*, with `criteria: {"<subject>": true_criteria, "NOT_<subject>": false_criteria}`. Jev answers each with `{choice: "<subject>"|"NOT_<subject>", confidence}` — `watch.classifyEntries()` reads these back, and `matchRate()` is just the fraction classified as the subject. There's no separate "is this worth mentioning" gate anymore: **flagging is `matchRate > FLAG_THRESHOLD` (0.8)** directly.
2. **If flagged, a second call writes the actual note.** `watch.buildWriteupMessages()` builds a normal chat-completions prompt (same instruction + history, plus a reaction note — see below) and sends it to whatever model is in `writeupModel`, via `openrouter.sendChatMessage()`. Skipped — no extra cost — when nothing's flagged; the popup just shows a plain "nothing stood out" message instead. The suggested alternative is banned from being about the same extracted **subject** in any form (using the same `intent.trueCriteria` from step 0) — e.g. a `FOOD` instruction won't get a "fancier" food suggestion back, a `GAMING` one won't get another gaming video — the ban follows whatever subject was actually extracted, not a hardcoded category.

#### Unofficial video-page enrichment

`lib/videoinfo.js`'s `enrichEntriesWithPageInfo()` gives Jev more than a bare title to classify on: for each video it fetches the public watch page (`https://www.youtube.com/watch?v=<id>`) and parses out `description` and `channel_title` from the `ytInitialPlayerResponse` JSON blob YouTube embeds for its own player — the same data any signed-out visitor's browser already receives. **This is not the official YouTube Data API** — no API key is used or required, but it's unsanctioned page-scraping: YouTube can change its page structure at any time and silently break it, and it may not comply with YouTube's terms of service for programmatic access. Every failure mode (network error, missing blob, JSON shape change) degrades to empty strings rather than throwing, so one bad video never blocks a check. Video transcripts are deliberately *not* fetched — YouTube's official captions API only permits downloading captions for videos you own, and the unofficial alternative was judged not worth the added fragility here.

### Remembering how you reacted, and tailoring the next note

Every check appends to two logs in `chrome.storage.local`:

- **`videoClassificationLog`** — every video Jev classified, with its match/no-match confidence and when it was checked (`watch.classifyEntries()`), capped at the most recent 500 entries.
- **`messageLog`** — every check's outcome: timestamp, whether it flagged, and the *match rate* (fraction of videos that matched), capped at the most recent 50.
- **`strikeCount`** — a lifetime (never trimmed) count of *delivered* alerts, shown as a 🔥 badge in the popup header. It's incremented by `finalizeAlert()` only once the alert has actually been delivered (video paused + note spoken) — not the moment Jev flags something — see below.

Before writing a new note, `lib/reflection.js`'s `describeReaction()` looks back through `messageLog` since the last flagged note to see what actually happened to your match rate:

- **Cut back and stayed down** → no special tailoring, default warm nudge.
- **Cut back, then slipped back into it** → the note is tailored to reward the earlier progress with genuine encouragement instead of scolding the relapse.
- **Never cut back at all** → the note stays warm but is nudged to be a little more direct, since the same nudge hasn't landed yet.

This is heuristic, not a guarantee — it only sees what Jev classified as matching, not real intent — but it means Alux's tone shifts based on your own history instead of repeating an identical message every time.

Other details:

- **Two ways it runs.** Clicking **Check now** triggers the cascade immediately. A `chrome.alarms` timer (`CHECK_ALARM_NAME` in `background.js`, every `CHECK_INTERVAL_MINUTES` = 20 minutes) also runs it unattended in the background, so a doomscrolling session can actually get interrupted instead of only surfacing next time you happen to open the popup.
- **What it reads.** `lib/watch.js` calls `chrome.history.search` (needs the `history` permission, added to `manifest.json`), filters it down to `youtube.com/watch` **and** `/shorts/` URLs (each Short is tagged `isShort` and marked `[Short]` in the prompt, since a Shorts binge is a different signal than watching a few long videos), de-dupes by video ID, and keeps the 50 most recent titles. This is the same watch history already recorded by the browser — no YouTube API calls, no separate OAuth grant for YouTube.
- **Lookback window matches the check interval, not a fixed range.** `queryYoutubeHistory(lookbackMs)` takes the window as a parameter — `background.js` passes `CHECK_INTERVAL_MS` (`CHECK_INTERVAL_MINUTES * 60 * 1000`), so each check (manual or periodic) only looks at watch activity since roughly the *last* check, instead of always re-scanning a fixed multi-day range. Without this, the same video watched once would keep getting reclassified — and could keep re-alerting — on every subsequent check until it aged out of a fixed window. The tradeoff: a check right after a gap (e.g. Chrome was closed, or the interval was just lengthened) will only see that short window, not everything watched during the gap.
- **Where it shows up.** The resulting text, a "checked at" timestamp, and Jev's confidence score are saved to `chrome.storage.local` and rendered in the popup (with a 🔊 replay via OpenRouter TTS). When the *periodic* alarm flags something, `background.js` also fires a `chrome.notifications` toast with the note text — the manual "Check now" path does not, since the popup is already open showing the result. Reopen the popup any time to see the last result; it's replaced next time either path runs.
- **Cost note:** every run (manual click or alarm tick) is a Jev call, plus a write-up call on top of that when something's flagged, roughly every 20 minutes in the background once connected — plus a TTS call whenever a note is spoken.
- **Pauses playback first.** Right before firing the periodic notification or speaking a note, `pauseYoutubeVideos()` in `background.js` messages `lib/content-pause.js` (injected into every open YouTube tab) to pause any playing `<video>`, so the interruption doesn't compete with autoplay.
- **Only interrupts if you're actually there.** The periodic check still runs (and still updates the reaction-tracking history) even if you've left YouTube, but `isUserOnYoutube()` gates the interruption itself — if the active tab in your last-focused window isn't YouTube, `runPeriodicCheck()` skips pausing/speaking/notifying entirely rather than firing at an empty room. The stored insight is left uncleared and the strike isn't recorded in that case, so it can still surface later (e.g. if you check manually).
- **Delivering the alert = pause + spoken note, then the strike and the message.** The periodic path has no popup open to play audio in, so `runPeriodicCheck()` generates the TTS audio itself and has `lib/content-pause.js` play it directly in the YouTube tab (`playAudioInYoutubeTabs()`), alongside the OS notification. Only once that's done does `finalizeAlert()` run: it increments `strikeCount` and clears the stored `lastInsight`, so a delivered note doesn't linger as a stale reminder the next time the popup opens. The manual "Check now" path does the same thing, just triggered by an `ALERT_DELIVERED` message from `popup.js` once it's played the note (via OpenRouter TTS or the browser-voice fallback) — replaying the note afterward via 🔊 does not re-trigger a strike.
- **Never suggests food.** The write-up prompt (`buildWriteupMessages()`) is explicitly told not to suggest food/eating-related videos as the alternative, even if they'd otherwise fit the instruction — since that content can trigger the same doomscrolling pattern instead of breaking it.
- **Auto-redirects to the suggestion.** The write-up call requests structured JSON (`response_format: 'json_object'` in `sendChatMessage()`) — `{"message": "...", "search_query": "..."}` — instead of plain prose, so `search_query` can be used programmatically. `lib/watch.js`'s `parseWriteupResponse()` splits that apart (falling back to treating the whole response as `message` with no query if the model didn't return valid JSON); once the alert is delivered, `directToYoutubeSearch()` in `background.js` navigates the active YouTube tab (or opens one, if none is open) straight to a YouTube search for that query — so the suggestion isn't just spoken, it's one click closer to acted on.

## Security notes / things to know before shipping this further

- `chrome.storage.local` is not encrypted in any special way — it's readable by anything with access to the user's local Chrome profile, same ceiling as any client-only app. The mitigation here is that each stored key is a small-blast-radius, individually revocable, user-owned credential — not a shared secret you're responsible for rotating.
- The `HTTP-Referer` / `X-Title` headers in `lib/openrouter.js` are for OpenRouter's app-attribution display only; they are not a security boundary. Update `HTTP-Referer` to point at your real extension listing/homepage before publishing.
- Add a "Disconnect" flow for users who want to revoke access (done — see `popup.js`); also tell users in your store listing that they can revoke the key directly from their OpenRouter dashboard.
- If you ever add a mode where *you* pay for usage (a shared/free tier), that's a materially different architecture: you'd need a real backend proxy holding your own key, plus per-user auth and rate limiting to keep it from being drained. Don't reuse this BYOK flow for that case.
- The `history` permission is broad — Chrome will show users a warning that this extension can read their entire browsing history, even though `lib/watch.js` only ever queries for `youtube.com` and discards everything else client-side. Say so plainly in your store listing; users have no way to verify the filtering themselves.
- The periodic-check notification puts the note's text directly in the OS notification tray — visible to anyone glancing at the screen or watching it get shared/recorded. Worth surfacing to users, since it's a different exposure than the popup (which only they open on purpose).
- The `*://*.youtube.com/*` host permission plus the always-on content script (`lib/content-pause.js`) means Chrome shows an additional "read and change your data on youtube.com" warning at install; the content script itself only ever pauses `<video>` elements on message, nothing else.
- `lib/videoinfo.js`'s per-video enrichment fetches each video's public watch page directly from `background.js` and parses out description/channel name from embedded JSON — no API key, but it's unofficial page-scraping (see "Unofficial video-page enrichment" above): not sanctioned by YouTube, could silently break if their page structure changes, and its terms-of-service compliance for programmatic use is genuinely unclear. Worth re-evaluating if you'd rather use the official YouTube Data API (a `videos.list` call) before shipping this further.

## Publishing

`manifest.json` now pins a `"key"` (an RSA public key), which fixes the extension's ID at `dlkpepejjblcohehdlgkgckaofgaompc` regardless of whether it's loaded unpacked or uploaded to the Chrome Web Store — without this, the ID (and therefore the OAuth redirect URI from `chrome.identity.getRedirectURL()`) would change between environments and break the "Connect OpenRouter account" flow. The corresponding private key isn't checked into this repo (it's not needed again — the public key baked into the manifest is what fixes the ID) and isn't required for uploading to the Store.

Before publishing:
1. Reload the extension in `chrome://extensions` and confirm it still shows connected, or reconnect if needed — the redirect URI just changed.
2. Register `https://dlkpepejjblcohehdlgkgckaofgaompc.chromiumapp.org/` as an allowed redirect URI wherever your OpenRouter OAuth app config lives, if it restricts them.
3. See `STORE_LISTING.md` for the draft listing copy and permission justifications, and `PRIVACY.md` for the privacy policy Chrome's review process will ask for a link to.
