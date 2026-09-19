# Chrome Web Store listing draft

## Extension name
Alux

## Short description (132 char max)
A quiet spirit that watches your YouTube habits against your own instruction and gently interrupts doomscrolling — using your own OpenRouter account.

## Detailed description

Alux is a small, unseen spirit that watches over your YouTube watch history and gently guides you back on track — with no backend server and no shared API key. You bring your own OpenRouter account (connected via OAuth, never a pasted key), so you're always in control of your own usage and cost.

**How it works**
1. Tell Alux what to watch for, in your own words — e.g. "nudge me if I'm doomscrolling true-crime videos late at night."
2. Alux checks your recent YouTube watch history against that instruction, both on demand ("Check now") and automatically in the background.
3. If it's confident something's worth mentioning, it pauses whatever's playing, speaks a short note aloud, and points you toward something better to watch instead — never anything food-related, since that can just feed the same doomscrolling pattern.
4. Alux remembers how you've responded to past notes and tailors its tone accordingly — encouraging when you've made progress, a little more direct if the same pattern keeps repeating.

**Privacy first**
- No first-party server, no analytics, no tracking.
- Your OpenRouter API key and all activity data stay in your browser's local storage.
- Only `youtube.com` history is ever read or sent anywhere (to OpenRouter, for the checks you've asked for) — see the full privacy policy for details.

## Category
Productivity

## Permission justifications (for Chrome Web Store review)

- **identity** — required for the OAuth PKCE flow that connects your own OpenRouter account; no client secret is ever stored.
- **storage** — stores your OpenRouter key, instruction, voice choice, and Alux's own activity history locally.
- **history** — reads browsing history so Alux can find your `youtube.com` watch/Shorts activity; everything else is filtered out and discarded immediately, never transmitted.
- **alarms** — runs the periodic (every ~20 minute) background check.
- **notifications** — shows an OS notification when the periodic check flags something and you're not looking at the popup.
- **host permission: openrouter.ai** — the only external service Alux calls (decisions, chat, and TTS endpoints), using your own API key.
- **host permission + content script: youtube.com** — pauses a playing video, plays a spoken note, and opens a YouTube search for a suggested alternative, only in direct response to a check.

## Screenshots to prepare
- Popup: connected state with an instruction set and a flagged note showing the 🔥 strike badge and 🔊 Replay button.
- Popup: voice picker dropdown.
- An OS notification example.
- (Optional) the "Connect OpenRouter account" flow.

## Support / privacy policy URL
Host `PRIVACY.md` from this repo somewhere public (e.g. GitHub Pages, or paste its raw GitHub URL) and link it in both the listing's "Privacy policy" field and its support contact.
