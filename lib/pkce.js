// PKCE helpers for OpenRouter's OAuth flow (RFC 7636).
// No client secret is used anywhere — the verifier never leaves this
// extension until the final token exchange, so there is nothing static
// to protect or leak.

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generateCodeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

export async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(new Uint8Array(digest));
}
