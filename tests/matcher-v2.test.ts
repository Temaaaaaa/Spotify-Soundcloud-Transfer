import test from 'node:test';
import assert from 'node:assert/strict';
import { match, rank } from '../server/matcher.js';
import type { SoundCloudTrack, SpotifyTrack } from '../shared/types.js';
const s: SpotifyTrack = {
  id: 's',
  title: 'Café feat. Ana',
  artists: ['M83', 'Ana'],
  album: 'Album',
  duration_ms: 200000,
  isrc: 'US-ABC-12-34567',
  url: null,
};
const c: SoundCloudTrack = {
  urn: 'soundcloud:tracks:1',
  title: 'M83 - Cafe ft Ana',
  duration: 200500,
  isrc: 'USABC1234567',
  metadata_artist: 'M83 feat Ana',
  user: { username: 'Record Label', urn: 'soundcloud:users:1' },
  permalink_url: 'https://soundcloud.com/a/b',
};
test('ISRC match, Unicode and label uploader can verify', () => {
  const x = match(s, c);
  assert.equal(x.category, 'VERIFIED');
  assert.ok(x.reasons.some((r) => r.includes('ISRC')));
});
test('conflicting ISRC, original vs remix, sped-up, slowed reverb, live, cover and radio edit avoid VERIFIED', () => {
  for (const other of [
    { ...c, isrc: 'GBXYZ1234567' },
    ...['Remix', 'Sped Up', 'Slowed + Reverb', 'Live', 'Cover', 'Radio Edit'].map((v) => ({
      ...c,
      title: `M83 - Cafe ft Ana (${v})`,
    })),
  ])
    assert.notEqual(match(s, other).category, 'VERIFIED');
});
test('duration mismatch, missing duration and ambiguous leaders require review', () => {
  assert.notEqual(match(s, { ...c, duration: 250000 }).category, 'VERIFIED');
  assert.notEqual(match(s, { ...c, duration: null }).category, 'VERIFIED');
  const r = rank(s, [c, { ...c, urn: 'soundcloud:tracks:2' }]);
  assert.equal(r[0].category, 'REVIEW');
});
