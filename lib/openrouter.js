// Thin client for the OpenRouter endpoints this extension needs.
// See https://openrouter.ai/docs/use-cases/oauth-pkce

export const AUTH_URL = 'https://openrouter.ai/auth';
export const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const MODEL = '~typesafe/jev-latest';

export function buildAuthUrl({ callbackUrl, codeChallenge, keyLabel }) {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    key_label: keyLabel
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchanges a one-time auth code for a user-owned OpenRouter API key.
// This is safe to call directly from the extension: PKCE replaces the
// client secret with the code_verifier, which only this extension ever held.
export async function exchangeCodeForKey(code, codeVerifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256'
    })
  });

  if (!res.ok) {
    throw new Error(`Key exchange failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.key) throw new Error('OpenRouter response did not include a key');
  return data.key;
}

export async function sendChatMessage(apiKey, messages) {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Identifies this app to OpenRouter (attribution only, not a secret).
      'HTTP-Referer': 'https://github.com/your-org/jev-chat-extension',
      'X-Title': 'Jev Chat Extension'
    },
    body: JSON.stringify({ model: MODEL, messages })
  });

  if (!res.ok) {
    throw new Error(`Chat request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
