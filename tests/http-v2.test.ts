import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectPages,
  HttpClient,
  retryDelay,
  safePageUrl,
  UnknownOutcome,
} from '../server/http.js';

test('Retry-After seconds and HTTP date are honored', () => {
  assert.ok(retryDelay('5', 0) >= 5000);
  assert.ok(retryDelay(new Date(Date.now() + 4000).toUTCString(), 0) >= 2000);
});
test('GET retries 429 and 5xx but POST network result is not replayed', async () => {
  let calls = 0;
  const waits: number[] = [];
  const http = new HttpClient(
    (async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : calls === 2
          ? new Response('', { status: 500 })
          : new Response('{}');
    }) as typeof fetch,
    async (ms) => {
      waits.push(ms);
    },
  );
  await http.request('https://api.soundcloud.com/me');
  assert.equal(calls, 3);
  assert.ok(waits[0] >= 2000);
  let posts = 0;
  const failed = new HttpClient((async () => {
    posts++;
    throw Error('lost');
  }) as typeof fetch);
  await assert.rejects(
    failed.request('https://api.soundcloud.com/likes/tracks/1', { method: 'POST' }),
    UnknownOutcome,
  );
  assert.equal(posts, 1);
});
test('pagination rejects cross origin and loops', async () => {
  assert.throws(
    () => safePageUrl('https://evil.example/tracks', 'https://api.soundcloud.com'),
    /origin/,
  );
  await assert.rejects(
    collectPages(
      '/tracks',
      'https://api.soundcloud.com',
      async () => ({ collection: [], next_href: '/tracks' }),
      (p) => p.collection,
      (p) => p.next_href,
    ),
    /loop/,
  );
});
