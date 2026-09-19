# Alux Privacy Policy

*Last updated: 2026-09-19*

Alux is a browser extension with no backend server. Everything it does happens on your device or as a direct call from your browser to OpenRouter, using your own OpenRouter account.

## What Alux accesses

- **Your OpenRouter API key.** Obtained via OpenRouter's OAuth PKCE flow when you click "Connect OpenRouter account." It is scoped to your OpenRouter account only, is stored in `chrome.storage.local` on your device, and is never sent anywhere except in `Authorization` headers on requests to `openrouter.ai`.
- **Your YouTube watch history.** Alux reads your browser's local history (via the `history` permission), filtered down to only `youtube.com/watch` and `youtube.com/shorts/` visits from a short recent window — everything else in your browsing history is ignored and never read or transmitted. The video titles and watch times that pass this filter are sent to OpenRouter (as part of the Jev decision call and, if flagged, the write-up call) so Alux can compare them against the instruction you gave it.
- **The instruction you type**, the **voice you pick**, and **notes Alux has written**, stored locally in `chrome.storage.local` so your settings and recent activity persist between sessions.
- **A YouTube tab you're currently viewing**, only to pause a playing video, play a spoken note aloud, or open a YouTube search for a suggested alternative — all in direct response to a check you triggered or the periodic check noticing a flagged pattern. The content script (`lib/content-pause.js`) does not read or transmit page content; it only reacts to messages from the extension's own background script.

## What Alux does *not* do

- No first-party server. No analytics, tracking pixels, or telemetry of any kind.
- No data is sent to Alux's developer or any third party other than OpenRouter (for the LLM/TTS calls you've configured) — see [OpenRouter's own privacy policy](https://openrouter.ai/privacy) for how they handle that data.
- Nothing is sold or shared for advertising.

## Data retention and control

- All data lives in `chrome.storage.local` on your device. Uninstalling the extension removes it.
- Clicking **Disconnect** in the popup removes your stored OpenRouter API key immediately; you can also revoke it directly from your OpenRouter dashboard at any time.
- Alux keeps a bounded local history for its own features: the last 500 video classifications and the last 50 check outcomes, used only to tailor future notes to your own past reactions (see the README's "Remembering how you reacted" section) — none of this leaves your device except as already described above.

## Contact

Questions about this policy can be directed to the extension's listed support contact on its Chrome Web Store page.
