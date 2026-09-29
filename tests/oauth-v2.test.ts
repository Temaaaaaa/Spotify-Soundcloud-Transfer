import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  begin,
  callback,
  connected,
  consumeState,
  pkceChallenge,
  providers,
} from '../server/auth.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('SoundCloud authorize uses PKCE S256, provider endpoint and scoped state', () => {
  process.env.SOUNDCLOUD_CLIENT_ID = 'id';
  process.env.SOUNDCLOUD_CLIENT_SECRET = 'secret';
  const auth = begin('soundcloud');
  const url = new URL(auth.url);
  assert.equal(url.origin, 'https://secure.soundcloud.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://127.0.0.1:3000/auth/soundcloud/callback',
  );
  assert.match(url.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pkceChallenge('abc'), 'abc');
  assert.throws(() => consumeState('spotify', auth.state, auth.state));
  assert.throws(() => consumeState('soundcloud', auth.state, auth.state));
});
test('OAuth state rejects wrong cookie, expiry and replay', () => {
  const now = Date.now();
  const a = begin('soundcloud', now);
  assert.throws(() => consumeState('soundcloud', a.state, 'wrong', now));
  const b = begin('soundcloud', now);
  assert.throws(() => consumeState('soundcloud', b.state, b.state, now + 600001));
  const c = begin('soundcloud', now);
  assert.ok(consumeState('soundcloud', c.state, c.state, now));
  assert.throws(() => consumeState('soundcloud', c.state, c.state, now));
});
test('SoundCloud code exchange posts verifier and no secrets appear in errors', async () => {
  const auth = begin('soundcloud');
  const challenge = new URL(auth.url).searchParams.get('code_challenge');
  let body: URLSearchParams | undefined;
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, providers.soundcloud.token);
    body = init.body as URLSearchParams;
    return new Response(JSON.stringify({ error: 'secret' }), { status: 400 });
  }) as typeof fetch;
  await assert.rejects(callback('soundcloud', auth.state, auth.state, 'code', fetcher), /HTTP 400/);
  assert.equal(body?.get('grant_type'), 'authorization_code');
  assert.equal(body?.get('client_secret'), 'secret');
  assert.equal(pkceChallenge(body!.get('code_verifier')!), challenge);
});
test('Spotify read-only scopes and separate endpoint', () => {
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  const url = new URL(begin('spotify').url);
  assert.equal(url.origin, 'https://accounts.spotify.com');
  assert.equal(
    url.searchParams.get('scope'),
    'user-library-read playlist-read-private playlist-read-collaborative',
  );
  assert.equal(url.searchParams.get('code_challenge'), null);
});
test('single-use refresh is serialized and rotating token is persisted atomically', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'oauth-rotation-')));
  try {
    const a = begin('soundcloud');
    await callback(
      'soundcloud',
      a.state,
      a.state,
      'code',
      (async () =>
        new Response(
          JSON.stringify({
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            expires_in: 0,
          }),
        )) as typeof fetch,
    );
    let refreshes = 0;
    const fetcher = (async (_url: string, init: RequestInit) => {
      refreshes++;
      assert.equal((init.body as URLSearchParams).get('refresh_token'), 'old-refresh');
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      );
    }) as typeof fetch;
    assert.deepEqual(
      await Promise.all([access('soundcloud', fetcher), access('soundcloud', fetcher)]),
      ['new-access', 'new-access'],
    );
    assert.equal(refreshes, 1);
    const saved = JSON.parse(await readFile('data/tokens/soundcloud.json', 'utf8'));
    assert.equal(saved.refresh_token, 'new-refresh');
  } finally {
    process.chdir(previous);
  }
});
test('unknown SoundCloud refresh result persists reconnect requirement', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'oauth-unknown-')));
  try {
    const a = begin('soundcloud');
    await callback(
      'soundcloud',
      a.state,
      a.state,
      'code',
      (async () =>
        new Response(
          JSON.stringify({ access_token: 'access', refresh_token: 'single-use', expires_in: 0 }),
        )) as typeof fetch,
    );
    await assert.rejects(
      access('soundcloud', (async () => {
        throw new Error('network lost');
      }) as typeof fetch),
      /reconnect/,
    );
    assert.equal(connected('soundcloud'), false);
    const saved = JSON.parse(await readFile('data/tokens/soundcloud.json', 'utf8'));
    assert.equal(saved.blocked, true);
  } finally {
    process.chdir(previous);
  }
});
