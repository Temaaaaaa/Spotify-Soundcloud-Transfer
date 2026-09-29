import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSpotifySnapshot,
  scCollection,
  scCollectionDetailed,
  soundcloud,
  soundCloudApi,
} from '../server/providers.js';
import { ApiError } from '../server/http.js';
test('Spotify snapshot paginates saved tracks and preserves unsupported followed playlist', async () => {
  const calls: string[] = [];
  const snap = await readSpotifySnapshot(async (path) => {
    calls.push(path);
    if (path === '/v1/me') return { id: 'owner' };
    if (path.includes('/me/tracks'))
      return {
        items: [
          {
            added_at: '2024-01-01T00:00:00Z',
            track: {
              id: 't1',
              name: 'Song',
              type: 'track',
              artists: [{ name: 'Artist' }],
              album: { name: 'Album' },
              duration_ms: 2000,
              external_ids: { isrc: 'USABC1234567' },
              external_urls: { spotify: 'https://open.spotify.com/track/t1' },
            },
          },
        ],
        next: null,
      };
    if (path.includes('/me/playlists'))
      return {
        items: [
          { id: 'p1', name: 'Followed', owner: { id: 'other' }, collaborative: false },
          { id: 'p2', name: 'Collaborative', owner: { id: 'other' }, collaborative: true },
        ],
        next: null,
      };
    if (path.includes('/p1/')) throw new ApiError(403, 'spotify');
    if (path.includes('/p2/'))
      return {
        items: [
          { added_at: null, item: { id: 't2', name: 'Local', type: 'track', is_local: true } },
        ],
        next: null,
      };
    throw Error(path);
  });
  assert.equal(snap.savedTracks[0], 't1');
  assert.equal(snap.playlists[0].status, 'UNSUPPORTED_SOURCE_PLAYLIST');
  assert.equal(snap.playlists[1].items[0].unavailable, true);
  assert.ok(calls.some((x) => x.includes('/items')));
});
test('playlist read-back fetches every linked page in collection order', async () => {
  const old = soundcloud.request;
  const calls: string[] = [];
  (soundcloud as any).request = async (url: string) => {
    calls.push(url);
    return calls.length === 1
      ? {
          collection: [
            { urn: 'soundcloud:tracks:1', title: 'One', user: {} },
            { urn: 'soundcloud:tracks:2', title: 'Two', user: {} },
          ],
          next_href:
            'https://api.soundcloud.com/playlists/soundcloud:playlists:1/tracks?cursor=next',
        }
      : { collection: [{ urn: 'soundcloud:tracks:3', title: 'Three', user: {} }], next_href: null };
  };
  try {
    const result = await soundCloudApi.playlistTracksDetailed('soundcloud:playlists:1');
    assert.deepEqual(
      result.tracks.map((t) => t.urn),
      ['soundcloud:tracks:1', 'soundcloud:tracks:2', 'soundcloud:tracks:3'],
    );
    assert.equal(result.pagesRead, 2);
    assert.match(calls[0], /linked_partitioning=true/);
    assert.match(calls[0], /limit=200/);
    assert.match(calls[0], /access=playable,preview,blocked/);
  } finally {
    (soundcloud as any).request = old;
  }
});

test('one-page playlist read-back reports one page', async () => {
  const result = await scCollectionDetailed(
    '/playlists/soundcloud:playlists:1/tracks?linked_partitioning=true',
    async () => ({ collection: [{ urn: 'soundcloud:tracks:1' }], next_href: null }),
  );
  assert.equal(result.pagesRead, 1);
  assert.deepEqual(
    result.items.map((x) => x.urn),
    ['soundcloud:tracks:1'],
  );
});

test('playlist pagination rejects foreign origin, malformed next_href and loops', async () => {
  await assert.rejects(
    scCollectionDetailed('/playlists/1/tracks', async () => ({
      collection: [],
      next_href: 'https://evil.example/tracks',
    })),
    /origin/,
  );
  await assert.rejects(
    scCollectionDetailed('/playlists/1/tracks', async () => ({
      collection: [],
      next_href: 42,
    })),
    /next_href/,
  );
  await assert.rejects(
    scCollectionDetailed('/playlists/1/tracks', async () => ({
      collection: [],
      next_href: 'https://api.soundcloud.com/playlists/1/tracks',
    })),
    /Pagination loop/,
  );
});
test('SoundCloud linked partitioning follows safe next_href', async () => {
  const seen: string[] = [];
  const all = await scCollection('/me/likes/tracks?linked_partitioning=true', async (url) => {
    seen.push(url);
    return {
      collection: [{ urn: `soundcloud:tracks:${seen.length}` }],
      next_href: seen.length === 1 ? 'https://api.soundcloud.com/me/likes/tracks?offset=1' : null,
    };
  });
  assert.equal(all.length, 2);
  await assert.rejects(
    scCollection('/tracks', async () => ({
      collection: [],
      next_href: 'https://evil.example/tracks',
    })),
    /origin/,
  );
});
test('official SoundCloud diagnostics call me, likes, search and selected track', async () => {
  const old = soundcloud.request;
  const calls: string[] = [];
  (soundcloud as any).request = async (path: string) => {
    calls.push(path);
    if (path === '/me') return { urn: 'soundcloud:users:1', username: 'U' };
    if (path.includes('/likes/tracks'))
      return {
        collection: [{ urn: 'soundcloud:tracks:1', title: 'Song', user: {} }],
        next_href: null,
      };
    if (path.includes('/tracks?q='))
      return {
        collection: [{ urn: 'soundcloud:tracks:2', title: 'Found', user: {} }],
        next_href: null,
      };
    if (path.includes('/tracks/soundcloud%3Atracks%3A2'))
      return { urn: 'soundcloud:tracks:2', title: 'Found', user: {} };
    throw Error(path);
  };
  try {
    assert.equal((await soundCloudApi.me()).username, 'U');
    assert.equal((await soundCloudApi.likes()).length, 1);
    assert.equal((await soundCloudApi.search('Artist Song')).length, 1);
    assert.equal((await soundCloudApi.track('soundcloud:tracks:2')).title, 'Found');
    assert.ok(calls.every((path) => !path.includes('api-v2')));
  } finally {
    (soundcloud as any).request = old;
  }
});
