import test from 'node:test';
import assert from 'node:assert/strict';
import { begin, callback } from '../server/auth.js';
import { access } from '../server/auth.js';
import {
  exchangeSpotifyToken,
  SPOTIFY_REDIRECT_URI,
  SPOTIFY_TOKEN_ENDPOINT,
  type SpotifyTokenDiagnostic,
} from '../server/spotify-token.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SPOTIFY_CLIENT_ID = 'test-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-secret';
const silent = (_r: SpotifyTokenDiagnostic) => {};
async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-token-'));
  return { dir, file: join(dir, '.env') };
}
const valid = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: 'access-value',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-value',
      scope: 'user-library-read playlist-read-private playlist-read-collaborative',
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('Spotify pre-response EACCES reports a concrete network error', async () => {
  const auth = begin('spotify');
  const denied = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EACCES' } });
  }) as typeof fetch;
  await assert.rejects(
    callback(
      'spotify',
      auth.state,
      auth.state,
      'one-use-code',
      denied,
      (await tempEnv()).file,
      silent,
    ),
    /TOKEN_EXCHANGE_NETWORK.*EACCES/,
  );
});
test('successful Spotify authorization code uses Basic, exact redirect and atomic env persistence', async () => {
  const { file } = await tempEnv();
  const auth = begin('spotify');
  const authorize = new URL(auth.url);
  await writeFile(
    file,
    '# keep this comment\nSPOTIFY_CLIENT_ID=test-id\nSPOTIFY_CLIENT_SECRET=test-secret\nSPOTIFY_ACCESS_TOKEN="stale"\n',
  );
  assert.equal(authorize.searchParams.get('redirect_uri'), SPOTIFY_REDIRECT_URI);
  assert.equal(authorize.searchParams.get('code_challenge'), null);
  let request: { url: string; init: RequestInit } | undefined;
  const records: SpotifyTokenDiagnostic[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    request = { url, init };
    return valid();
  }) as typeof fetch;
  await callback('spotify', auth.state, auth.state, 'fresh-code', fetcher, file, (r) =>
    records.push(r),
  );
  assert.equal(request?.url, SPOTIFY_TOKEN_ENDPOINT);
  assert.equal(request?.init.method, 'POST');
  const headers = request!.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(
    headers.Authorization,
    'Basic ' + Buffer.from('test-id:test-secret').toString('base64'),
  );
  assert.deepEqual(
    [...(request!.init.body as URLSearchParams).entries()],
    [
      ['grant_type', 'authorization_code'],
      ['code', 'fresh-code'],
      ['redirect_uri', SPOTIFY_REDIRECT_URI],
    ],
  );
  const saved = await readFile(file, 'utf8');
  assert.match(saved, /SPOTIFY_ACCESS_TOKEN="access-value"/);
  assert.match(saved, /SPOTIFY_REFRESH_TOKEN="refresh-value"/);
  assert.match(saved, /SPOTIFY_EXPIRES_AT="\d+"/);
  assert.match(saved, /# keep this comment/);
  assert.equal((saved.match(/SPOTIFY_ACCESS_TOKEN=/g) || []).length, 1);
  assert.ok(records.some((r) => r.phase === 'persist' && r.persistenceSucceeded));
  const logs = JSON.stringify(records);
  for (const secret of [
    'fresh-code',
    'access-value',
    'refresh-value',
    'test-secret',
    headers.Authorization,
  ])
    assert.equal(logs.includes(secret), false);
});
test('Spotify HTTP 400 and 401 surface sanitized upstream errors', async () => {
  for (const [status, error] of [
    [400, 'invalid_grant'],
    [401, 'invalid_client'],
  ] as const) {
    const auth = begin('spotify');
    const records: SpotifyTokenDiagnostic[] = [];
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          error,
          access_token: 'hidden-access',
          refresh_token: 'hidden-refresh',
          error_description: 'bad fresh-code test-secret hidden-access hidden-refresh',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    await assert.rejects(
      callback(
        'spotify',
        auth.state,
        auth.state,
        'fresh-code',
        fetcher,
        (await tempEnv()).file,
        (r) => records.push(r),
      ),
      (e) => {
        assert.match((e as Error).message, new RegExp(`TOKEN_HTTP_ERROR: HTTP ${status} ${error}`));
        assert.equal((e as Error).message.includes('fresh-code'), false);
        assert.equal((e as Error).message.includes('test-secret'), false);
        assert.equal((e as Error).message.includes('hidden-access'), false);
        assert.equal((e as Error).message.includes('hidden-refresh'), false);
        return true;
      },
    );
    assert.equal(records.at(-1)?.status, status);
    assert.equal(records.at(-1)?.error, error);
    assert.equal(JSON.stringify(records).includes('hidden-access'), false);
  }
});
test('Spotify HTTP 200 malformed JSON and schema have TOKEN_RESPONSE_INVALID', async () => {
  const fields = {
    grant_type: 'authorization_code' as const,
    code: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
  };
  for (const response of [
    new Response('{broken', { status: 200 }),
    new Response(JSON.stringify({ access_token: 'a', expires_in: 3600, refresh_token: 'r' }), {
      status: 200,
    }),
  ]) {
    await assert.rejects(
      exchangeSpotifyToken(
        'id',
        'secret',
        fields,
        undefined,
        (async () => response) as typeof fetch,
        silent,
      ),
      /TOKEN_RESPONSE_INVALID/,
    );
  }
});
test('ambiguous Spotify POST network failure is not replayed and is marked unknown', async () => {
  const auth = begin('spotify');
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  }) as typeof fetch;
  await assert.rejects(
    callback(
      'spotify',
      auth.state,
      auth.state,
      'one-use-code',
      fetcher,
      (await tempEnv()).file,
      silent,
    ),
    /TOKEN_EXCHANGE_UNKNOWN.*ECONNRESET/,
  );
  assert.equal(calls, 1);
});
test('Spotify valid token with failed atomic save is TOKEN_PERSIST_FAILED', async () => {
  const { dir } = await tempEnv();
  const auth = begin('spotify');
  const records: SpotifyTokenDiagnostic[] = [];
  await assert.rejects(
    callback(
      'spotify',
      auth.state,
      auth.state,
      'code',
      (async () => valid()) as typeof fetch,
      dir,
      (r) => records.push(r),
    ),
    /TOKEN_PERSIST_FAILED/,
  );
  assert.ok(records.some((r) => r.phase === 'persist' && !r.persistenceSucceeded));
});
test('Spotify refresh keeps old refresh token when response omits a new one', async () => {
  const { file } = await tempEnv();
  const auth = begin('spotify');
  await callback(
    'spotify',
    auth.state,
    auth.state,
    'code',
    (async () => valid({ expires_in: 1 })) as typeof fetch,
    file,
    silent,
  );
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, SPOTIFY_TOKEN_ENDPOINT);
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Basic ' + Buffer.from('test-id:test-secret').toString('base64'),
    );
    assert.deepEqual(
      [...(init.body as URLSearchParams).entries()],
      [
        ['grant_type', 'refresh_token'],
        ['refresh_token', 'refresh-value'],
      ],
    );
    return new Response(
      JSON.stringify({
        access_token: 'next-access',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'user-library-read',
      }),
    );
  }) as typeof fetch;
  assert.equal(await access('spotify', fetcher, file, silent), 'next-access');
  assert.equal(calls, 1);
  assert.match(await readFile(file, 'utf8'), /SPOTIFY_REFRESH_TOKEN="refresh-value"/);
});
