# Alux

*A small, unseen spirit that watches over you and guides you in the right direction.*

A Chrome extension (Manifest V3) that watches your YouTube watch history against an instruction you give it, using [`~typesafe/jev-latest`](https://openrouter.ai/~typesafe/jev-latest) (TypeSafe's "Jev" decision model) on OpenRouter and **each user's own OpenRouter account** — no backend server, no shared API key baked into the extension.

## How it works

You tell Alux, in your own words, what kind of doomscrolling you want it to watch out for — like "true-crime videos late at night" or "food videos." Alux quietly figures out what content category you mean, then checks in on your recent YouTube watching every few minutes.

If it notices you've been mostly watching that kind of content, it steps in: it pauses the video, gently speaks a short note out loud, suggests something completely different worth watching instead, and takes you straight to a search for that suggestion — all without you needing to do anything.

Alux also remembers how you've responded to past notes. If you cut back before but slipped back into it, it'll be encouraging rather than scolding. If a nudge hasn't worked at all, it'll be a bit more direct next time. And it keeps a running count of how many times it's caught you, shown right in the popup.

Everything runs using your own OpenRouter account (connected once, up front) — there's no separate server involved, and nothing about your watch history is stored anywhere except on your own device.

## How to install

Alux isn't on the Chrome Web Store yet, so for now it's installed manually — this takes about a minute:

1. Download this repository to your computer (green **Code** button on GitHub → **Download ZIP**, then unzip it — or `git clone` it if you're comfortable with that).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**, using the toggle in the top-right corner.
4. Click **Load unpacked**, and select the folder you downloaded.
5. The Alux icon will appear in your browser toolbar. Click it to get started — see "How to use" below.

## How to use

1. **Click the Alux icon** in your browser toolbar and press **Connect OpenRouter account**. This opens OpenRouter's sign-in page — approve the request and you're connected.
2. **Tell Alux what to watch for.** Type an instruction in your own words, like *"nudge me if I'm doomscrolling food videos"* or *"tell me if I keep avoiding the coding tutorials I said I'd watch."*
3. **Pick a voice** for how the note gets read aloud, and click **Save**.
4. That's it. Alux checks your recent YouTube activity automatically in the background every few minutes — you don't need to keep the popup open. You can also press **Check now** any time to check immediately.
5. **When something's flagged**, Alux will pause what's playing, speak a short note, and open a YouTube search for something better to watch instead. You'll also see the note (and a 🔊 Replay button) if you open the popup.
6. Press **Disconnect** in the popup any time to stop Alux and remove your saved connection — you can also revoke access directly from your OpenRouter account dashboard.

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
5. The resulting key is stored in `chrome.storage.local` (not `.sync`, so it doesn't propagate across the user's other synced Chrome profiles) and used as a normal `Authorization: Bearer` header for every OpenRouter request the extension makes — the decisions call and write-up call in `checkYoutubeHistory()`, plus the TTS call in `speakText()`.

See OpenRouter's docs for the current parameter names: https://openrouter.ai/docs/use-cases/oauth-pkce

## Project layout

```
manifest.json          MV3 manifest — identity + storage + history + alarms + notifications permissions, openrouter.ai + youtube.com host permissions, the pause-video content script
background.js          Service worker: runs the OAuth flow, stores settings, runs the check (on-demand and on a recurring alarm), fires notifications, pauses YouTube before alerting/speaking
lib/pkce.js            PKCE code_verifier / code_challenge generation (Web Crypto)
lib/openrouter.js      OpenRouter endpoint URLs — auth-exchange, chat-completions, the decisions API, and TTS
lib/watch.js           Reads chrome.history for YouTube watches; builds the Jev question(s) + the write-up prompt; per-video classification helpers
lib/videoinfo.js       Best-effort per-video description/channel enrichment (unofficial watch-page fetch, no API key)
lib/reflection.js      Pure logic: compares match-rate history to figure out how the user reacted to past notes
lib/content-pause.js   Content script injected into YouTube tabs; pauses <video> on request from background.js
popup.html/.js/.css    Popup UI: connect button, watch-instruction + voice picker, disconnect button
```

## Evaluating classification accuracy

An `evals/` folder can measure how accurately Jev classifies real videos against a given instruction, reusing the exact same production code (`lib/watch.js`, `lib/videoinfo.js`, `lib/openrouter.js`) rather than reimplementing it. It's deliberately git-ignored and not part of this repository, since a useful dataset for this tends to involve real watch-history data — keep it local-only.

