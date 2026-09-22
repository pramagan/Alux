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
// Cheaper than openai/gpt-4o-mini ($0.12/$0.48 per M tokens vs. ~$0.15/$0.60,
// per OpenRouter's own pricing) for a task (a two-sentence JSON writeup) that
// doesn't need a top-tier model. Uses the "-latest" alias, same pattern as
// JEV_MODEL above, so it doesn't go stale as DeepSeek ships newer Flash
// versions.
export const DEFAULT_WRITEUP_MODEL = '~deepseek/deepseek-flash-latest';
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

// Returns { content, usage } rather than just the text — `usage` (OpenRouter's
// standard { prompt_tokens, completion_tokens, ... }) is needed by callers
// that want to log real cost via estimateCostUsd() below.
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
  return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage ?? null };
}

// Calls Jev on OpenRouter's decisions endpoint with a set of typed questions
// (noul/choice/score) and returns { answers, usage } — the typed answers
// object (no free text) plus token usage for cost logging (see
// estimateCostUsd below).
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
  return { answers: data.answers ?? {}, usage: data.usage ?? null };
}

// Prices as published on openrouter.ai/models (checked 2026-09-20), used
// only to turn a response's real measured token usage into an approximate
// dollar figure for logging — not for billing, and not a live price feed.
// Models outside this map (e.g. a custom writeup model set via
// WRITEUP_MODEL_KEY) just estimate to $0 rather than throwing.
const PRICING = {
  [JEV_MODEL]: { inputPerM: 0.042, outputPerM: 0 },
  [DEFAULT_WRITEUP_MODEL]: { inputPerM: 0.12, outputPerM: 0.48 }
};

export function estimateCostUsd(usage, model) {
  const price = PRICING[model];
  if (!usage || !price) return 0;
  // Guard against a `usage` object that exists but doesn't have these exact
  // field names (e.g. the alpha decisions endpoint may shape it
  // differently than the chat completions one) — Number(undefined) is NaN,
  // which would otherwise silently poison every cost total it's added to.
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  if (!('prompt_tokens' in usage) || !('completion_tokens' in usage)) {
    console.warn(`[Alux] estimateCostUsd: unexpected usage shape for ${model}:`, usage);
  }
  return (promptTokens / 1e6) * price.inputPerM + (completionTokens / 1e6) * price.outputPerM;
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
