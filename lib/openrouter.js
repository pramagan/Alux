// Thin client for the OpenRouter endpoints this extension needs.
// See https://openrouter.ai/docs/use-cases/oauth-pkce

export const AUTH_URL = 'https://openrouter.ai/auth';
export const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';

// ~typesafe/jev-latest is a *decisions* model (OpenRouter's structured
// noul/choice/score interface below) — it has no chat/completions endpoint
// and returns typed values only, never prose. See lib/watch.js for how it's
// combined with a normal chat model to produce human-readable text.
export const JEV_MODEL = '~typesafe/jev-latest';
export const DEFAULT_WRITEUP_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_TTS_MODEL = 'mistralai/voxtral-mini-tts-2603';
export const DEFAULT_TTS_VOICE = 'en_paul_neutral';

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

export async function sendChatMessage(apiKey, messages, model, { responseFormat } = {}) {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Identifies this app to OpenRouter (attribution only, not a secret).
      'HTTP-Referer': 'https://github.com/your-org/jev-chat-extension',
      'X-Title': 'Alux'
    },
    body: JSON.stringify({
      model,
      messages,
      ...(responseFormat ? { response_format: { type: responseFormat } } : {})
    })
  });

  if (!res.ok) {
    throw new Error(`Chat request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Calls Jev on OpenRouter's decisions endpoint with a set of typed questions
// (noul/choice/score) and returns the typed `answers` object — no free text.
// See https://openrouter.ai/docs/api/api-reference/alphadecisions
export async function askJevDecision(apiKey, { state, questions }) {
  const res = await fetch(DECISIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions })
  });

  if (!res.ok) {
    throw new Error(`Decision request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.answers ?? {};
}

// OpenAI-compatible TTS endpoint: returns raw MP3 bytes for the given text.
// See https://openrouter.ai/docs/guides/overview/multimodal/tts
export async function synthesizeSpeech(apiKey, text, model, voice) {
  const res = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' })
  });

  if (!res.ok) {
    throw new Error(`Speech request failed (${res.status}): ${await res.text()}`);
  }

  return res.arrayBuffer();
}
