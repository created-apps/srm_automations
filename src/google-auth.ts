import { createSign } from 'node:crypto';
import { config } from './config';

/**
 * Google service-account auth without a client library.
 *
 * The sibling services stay dependency-light, so rather than pull in
 * googleapis we mint an OAuth access token by hand: build a JWT asserting the
 * service account, sign it RS256 with the account's private key, and exchange
 * it at the token endpoint for a bearer token. Tokens last an hour; we cache
 * one and refresh a minute early.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive';

let cached: { token: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signedJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.google.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(config.google.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt(),
    }),
  });

  const data = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error_description?: string }
    | null;

  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${data?.error_description ?? 'no access_token'}`
    );
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
  return cached.token;
}
