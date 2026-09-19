# Alux

*A small, unseen spirit that watches over you and guides you in the right direction.*

A Chrome extension (Manifest V3) that watches your YouTube watch history against an instruction you give it, using [`~typesafe/jev-latest`](https://openrouter.ai/~typesafe/jev-latest) on OpenRouter and **each user's own OpenRouter account** — no backend server, no shared API key baked into the extension.

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
5. The resulting key is stored in `chrome.storage.local` (not `.sync`, so it doesn't propagate across the user's other synced Chrome profiles) and used as a normal `Authorization: Bearer` header for the chat-completions request in `checkYoutubeHistory()`.

See OpenRouter's docs for the current parameter names: https://openrouter.ai/docs/use-cases/oauth-pkce

## Project layout

```
manifest.json       MV3 manifest — identity + storage + history permissions, openrouter.ai host permission
background.js       Service worker: runs the OAuth flow, stores the key, handles watch requests
lib/pkce.js          PKCE code_verifier / code_challenge generation (Web Crypto)
lib/openrouter.js    OpenRouter endpoint URLs + auth-exchange + chat-completions calls
lib/watch.js          Reads chrome.history for YouTube watches, builds the prompt sent to jev-latest
popup.html/.js/.css  Popup UI: connect button, watch-instruction box, disconnect button
```

## Running it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project directory.
4. Click the extension icon, then **Connect OpenRouter account** — this opens OpenRouter's authorization page in a popup window.
5. Approve the request. You're returned to the extension, now connected and ready to set a watch instruction.

## Watching your YouTube history

The popup is a free-text box where you tell Alux what to pay attention to in your own YouTube watch history — e.g. *"nudge me if I'm doomscrolling true-crime videos late at night"* or *"tell me if I've been avoiding the coding tutorials I said I'd get through"*.

- **On-demand only.** Nothing runs in the background or on a timer. Clicking **Check now** is the only thing that triggers a read.
- **What it reads.** `lib/watch.js` calls `chrome.history.search` (needs the `history` permission, added to `manifest.json`) scoped to the last 7 days, filters it down to `youtube.com/watch` URLs, de-dupes by video ID, and keeps the 50 most recent titles. This is the same watch history already recorded by the browser — no YouTube API calls, no separate OAuth grant for YouTube.
- **What happens next.** Those titles plus your saved instruction get sent as one chat message to `~typesafe/jev-latest` via `openrouter.sendChatMessage`, asking Alux to reflect on the history *only insofar as it's relevant to your instruction* — not to summarize everything.
- **Where it shows up.** The response and a "checked at" timestamp are saved to `chrome.storage.local` and rendered directly in the popup — no notifications, no badge. Reopen the popup any time to see the last result; it's replaced next time you click **Check now**.
- **Cost note:** every click is one more request against your OpenRouter account.

## Security notes / things to know before shipping this further

- `chrome.storage.local` is not encrypted in any special way — it's readable by anything with access to the user's local Chrome profile, same ceiling as any client-only app. The mitigation here is that each stored key is a small-blast-radius, individually revocable, user-owned credential — not a shared secret you're responsible for rotating.
- The `HTTP-Referer` / `X-Title` headers in `lib/openrouter.js` are for OpenRouter's app-attribution display only; they are not a security boundary. Update `HTTP-Referer` to point at your real extension listing/homepage before publishing.
- Add a "Disconnect" flow for users who want to revoke access (done — see `popup.js`); also tell users in your store listing that they can revoke the key directly from their OpenRouter dashboard.
- If you ever add a mode where *you* pay for usage (a shared/free tier), that's a materially different architecture: you'd need a real backend proxy holding your own key, plus per-user auth and rate limiting to keep it from being drained. Don't reuse this BYOK flow for that case.
- The `history` permission is broad — Chrome will show users a warning that this extension can read their entire browsing history, even though `lib/watch.js` only ever queries for `youtube.com` and discards everything else client-side. Say so plainly in your store listing; users have no way to verify the filtering themselves.
