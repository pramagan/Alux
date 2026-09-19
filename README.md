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
5. The resulting key is stored in `chrome.storage.local` (not `.sync`, so it doesn't propagate across the user's other synced Chrome profiles) and used as a normal `Authorization: Bearer` header for both OpenRouter requests `checkYoutubeHistory()` makes (see below).

See OpenRouter's docs for the current parameter names: https://openrouter.ai/docs/use-cases/oauth-pkce

## Project layout

```
manifest.json       MV3 manifest — identity + storage + history permissions, openrouter.ai host permission
background.js       Service worker: runs the OAuth flow, stores settings, runs the two-step check
lib/pkce.js          PKCE code_verifier / code_challenge generation (Web Crypto)
lib/openrouter.js    OpenRouter endpoint URLs — auth-exchange, chat-completions, and the decisions API
lib/watch.js          Reads chrome.history for YouTube watches; builds the Jev question + the write-up prompt
popup.html/.js/.css  Popup UI: connect button, watch-instruction + model boxes, disconnect button
```

## Running it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project directory.
4. Click the extension icon, then **Connect OpenRouter account** — this opens OpenRouter's authorization page in a popup window.
5. Approve the request. You're returned to the extension, now connected and ready to set a watch instruction.

## Watching your YouTube history

The popup has a free-text box where you tell Alux what to pay attention to in your own YouTube watch history — e.g. *"nudge me if I'm doomscrolling true-crime videos late at night"* or *"tell me if I've been avoiding the coding tutorials I said I'd get through"* — plus a second field for the model Alux should use to write its note (defaults to `openai/gpt-4o-mini`, editable any time).

### Why this is a two-step cascade, not one call

`~typesafe/jev-latest` ("Jev") looked like a normal chat model from its OpenRouter listing, but it isn't one: it's TypeSafe's structured-decision model, served from **`POST https://openrouter.ai/api/alpha/decisions`**, not `/chat/completions`. You send it typed questions (`noul` = boolean-with-confidence, `choice`, or `score`) against a `state` object, and it returns typed answers — a confidence number, a chosen label, a score. There is **no free-text field anywhere in the response**. Calling it through `/chat/completions` (what an earlier version of this extension did) fails with a 400 telling you to use the decisions endpoint instead.

So "Check now" runs two calls:

1. **Jev decides if anything's worth mentioning.** `checkYoutubeHistory()` in `background.js` builds a request via `watch.buildJevDecisionRequest()` — your instruction and the recent watch titles go into `state`, and a single `should_flag` question (type `noul`) asks Jev whether the history matches what you described. This is fast and cheap (Jev is priced near-zero output cost) and runs on **every** click.
2. **If Jev's confidence is ≥ `FLAG_THRESHOLD` (0.5, in `lib/watch.js`), a second call writes the actual note.** `watch.buildWriteupMessages()` builds a normal chat-completions prompt (same instruction + history) and sends it to whatever model is in the "model" field, via `openrouter.sendChatMessage()`. This step is skipped — no second API call, no extra cost — when Jev doesn't flag anything; the popup just shows a plain "nothing stood out" message instead.

Other details:

- **On-demand only.** Nothing runs in the background or on a timer. Clicking **Check now** is the only thing that triggers either call.
- **What it reads.** `lib/watch.js` calls `chrome.history.search` (needs the `history` permission, added to `manifest.json`) scoped to the last 7 days, filters it down to `youtube.com/watch` URLs, de-dupes by video ID, and keeps the 50 most recent titles. This is the same watch history already recorded by the browser — no YouTube API calls, no separate OAuth grant for YouTube.
- **Where it shows up.** The resulting text, a "checked at" timestamp, and Jev's confidence score are saved to `chrome.storage.local` and rendered directly in the popup — no notifications, no badge. Reopen the popup any time to see the last result; it's replaced next time you click **Check now**.
- **Cost note:** every click is a Jev call, plus a write-up call on top of that when something's flagged.

## Security notes / things to know before shipping this further

- `chrome.storage.local` is not encrypted in any special way — it's readable by anything with access to the user's local Chrome profile, same ceiling as any client-only app. The mitigation here is that each stored key is a small-blast-radius, individually revocable, user-owned credential — not a shared secret you're responsible for rotating.
- The `HTTP-Referer` / `X-Title` headers in `lib/openrouter.js` are for OpenRouter's app-attribution display only; they are not a security boundary. Update `HTTP-Referer` to point at your real extension listing/homepage before publishing.
- Add a "Disconnect" flow for users who want to revoke access (done — see `popup.js`); also tell users in your store listing that they can revoke the key directly from their OpenRouter dashboard.
- If you ever add a mode where *you* pay for usage (a shared/free tier), that's a materially different architecture: you'd need a real backend proxy holding your own key, plus per-user auth and rate limiting to keep it from being drained. Don't reuse this BYOK flow for that case.
- The `history` permission is broad — Chrome will show users a warning that this extension can read their entire browsing history, even though `lib/watch.js` only ever queries for `youtube.com` and discards everything else client-side. Say so plainly in your store listing; users have no way to verify the filtering themselves.
