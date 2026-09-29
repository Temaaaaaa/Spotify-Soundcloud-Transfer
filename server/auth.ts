import { envFile } from './environment.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Provider } from '../shared/types.js';
import { loadJson, saveJson } from './storage.js';
import {
  SPOTIFY_REDIRECT_URI,
  SPOTIFY_TOKEN_ENDPOINT,
  exchangeSpotifyToken,
  persistSpotifyToken,
  clearSpotifyToken,
  spotifyTokenFromEnvironment,
  logSpotifyDiagnostic,
  type SpotifyDiagnosticSink,
} from './spotify-token.js';

export const port = Number(process.env.PORT || 3000);
export const origin = `http://127.0.0.1:${port}`;
type Token = { access_token: string; refresh_token: string; expires_at: number; blocked?: boolean };
type Config = {
  authorize: string;
  token: string;
  api: string;
  scheme: string;
  scopes?: string;
  pkce: boolean;
};
export const SpotifyOAuth: Config = {
  authorize: 'https://accounts.spotify.com/authorize',
  token: SPOTIFY_TOKEN_ENDPOINT,
  api: 'https://api.spotify.com',
  scheme: 'Bearer',
  scopes: 'user-library-read playlist-read-private playlist-read-collaborative',
  pkce: false,
};
export const SoundCloudOAuth: Config = {
  authorize: 'https://secure.soundcloud.com/authorize',
  token: 'https://secure.soundcloud.com/oauth/token',
  api: 'https://api.soundcloud.com',
  scheme: 'OAuth',
  pkce: true,
};
export const providers: Record<Provider, Config> = {
  spotify: SpotifyOAuth,
  soundcloud: SoundCloudOAuth,
};
const pending = new Map<string, { provider: Provider; verifier: string; expires: number }>();
const refreshes = new Map<Provider, Promise<void>>();
const tokens: Partial<Record<Provider, Token>> = {};
const blocked = new Set<Provider>();
const file = (p: Provider) => `data/tokens/${p}.json`;
const credentials = (p: Provider) => ({
  id: process.env[`${p.toUpperCase()}_CLIENT_ID`] || '',
  secret: process.env[`${p.toUpperCase()}_CLIENT_SECRET`] || '',
});
export const configured = (p: Provider) => !!credentials(p).id && !!credentials(p).secret;
export const connected = (p: Provider) => !!tokens[p] && !blocked.has(p);
export async function initializeAuth() {
  const spotify = spotifyTokenFromEnvironment();
  if (spotify) tokens.spotify = spotify;
  const soundcloud = await loadJson<Token>(
    file('soundcloud'),
    (v): v is Token => v?.access_token && v?.refresh_token && Number.isFinite(v?.expires_at),
  );
  if (soundcloud) {
    tokens.soundcloud = soundcloud;
    if (soundcloud.blocked) blocked.add('soundcloud');
  }
}
export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}
export function begin(p: Provider, now = Date.now()) {
  if (!configured(p)) throw new Error(`${p} credentials missing`);
  if (p === 'spotify' && port !== 3000) throw new Error('Spotify redirect URI requires PORT=3000');
  for (const [key, value] of pending) if (value.expires < now) pending.delete(key);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  pending.set(state, { provider: p, verifier, expires: now + 600000 });
  const url = new URL(providers[p].authorize);
  const params: Record<string, string> = {
    client_id: credentials(p).id,
    redirect_uri: p === 'spotify' ? SPOTIFY_REDIRECT_URI : `${origin}/auth/${p}/callback`,
    response_type: 'code',
    state,
  };
  if (providers[p].scopes) params.scope = providers[p].scopes;
  if (providers[p].pkce) {
    params.code_challenge = pkceChallenge(verifier);
    params.code_challenge_method = 'S256';
  }
  url.search = new URLSearchParams(params).toString();
  return { state, url: url.toString() };
}
export function consumeState(p: Provider, state: string, cookie: string, now = Date.now()) {
  const entry = pending.get(state);
  pending.delete(state);
  const a = Buffer.from(state),
    b = Buffer.from(cookie);
  if (
    !entry ||
    entry.provider !== p ||
    entry.expires < now ||
    a.length !== b.length ||
    !timingSafeEqual(a, b)
  )
    throw new Error('OAuth state invalid or expired');
  return entry.verifier;
}
async function markBlocked(p: Provider) {
  blocked.add(p);
  if (!tokens[p]) return;
  try {
    await saveJson(file(p), { ...tokens[p], blocked: true });
  } catch {
    try {
      await unlink(file(p));
    } catch {
      throw new Error(
        `${p} OAuth status could not be secured on disk; remove the token file before restart`,
      );
    }
  }
}
async function tokenRequest(
  p: 'soundcloud',
  fields: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<Token> {
  const { id, secret } = credentials(p);
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  body.set('client_id', id);
  body.set('client_secret', secret);
  let response: Response;
  try {
    response = await fetcher(providers[p].token, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    await markBlocked(p);
    throw new Error('soundcloud token result unknown; reconnect');
  }
  if (!response.ok) {
    await markBlocked(p);
    throw new Error(`${p} token request failed: HTTP ${response.status}; reconnect`);
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    await markBlocked(p);
    throw new Error(`${p} invalid token response; reconnect`);
  }
  const refresh = payload?.refresh_token;
  if (
    typeof payload?.access_token !== 'string' ||
    typeof refresh !== 'string' ||
    !Number.isFinite(payload?.expires_in)
  ) {
    await markBlocked(p);
    throw new Error(`${p} invalid token response; reconnect`);
  }
  return {
    access_token: payload.access_token,
    refresh_token: refresh,
    expires_at: Date.now() + payload.expires_in * 1000,
  };
}
async function saveToken(p: Provider, token: Token) {
  try {
    await saveJson(file(p), token);
  } catch {
    await markBlocked(p);
    throw new Error(`${p} token could not be saved; reconnect`);
  }
  tokens[p] = token;
  blocked.delete(p);
}
export async function callback(
  p: Provider,
  state: string,
  cookie: string,
  code: string,
  fetcher: typeof fetch = fetch,
  spotifyFile = envFile,
  diagnostic: SpotifyDiagnosticSink = logSpotifyDiagnostic,
) {
  const verifier = consumeState(p, state, cookie);
  if (!code) throw new Error('OAuth code missing');
  if (p === 'spotify') {
    const token = await exchangeSpotifyToken(
      credentials(p).id,
      credentials(p).secret,
      { grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI },
      undefined,
      fetcher,
      diagnostic,
    );
    await persistSpotifyToken(token, spotifyFile, diagnostic);
    tokens.spotify = token;
    return;
  }
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${origin}/auth/${p}/callback`,
  };
  if (providers[p].pkce) fields.code_verifier = verifier;
  await saveToken(p, await tokenRequest(p, fields, fetcher));
}
export async function access(
  p: Provider,
  fetcher: typeof fetch = fetch,
  spotifyFile = envFile,
  diagnostic: SpotifyDiagnosticSink = logSpotifyDiagnostic,
) {
  if (!connected(p)) throw new Error(`Reconnect ${p}`);
  if (tokens[p]!.expires_at < Date.now() + 60000) {
    if (!refreshes.has(p)) {
      const task = (async () => {
        if (p === 'spotify') {
          const token = await exchangeSpotifyToken(
            credentials(p).id,
            credentials(p).secret,
            { grant_type: 'refresh_token', refresh_token: tokens[p]!.refresh_token },
            tokens[p]!.refresh_token,
            fetcher,
            diagnostic,
          );
          await persistSpotifyToken(token, spotifyFile, diagnostic);
          tokens.spotify = token;
        } else {
          await saveToken(
            p,
            await tokenRequest(
              p,
              { grant_type: 'refresh_token', refresh_token: tokens[p]!.refresh_token },
              fetcher,
            ),
          );
        }
      })().finally(() => refreshes.delete(p));
      refreshes.set(p, task);
    }
    await refreshes.get(p);
  }
  return tokens[p]!.access_token;
}
export async function disconnect(p: Provider) {
  if (p === 'spotify') {
    await clearSpotifyToken();
    tokens.spotify = undefined;
    return;
  }
  tokens[p] = undefined;
  blocked.delete(p);
  await unlink(file(p)).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
