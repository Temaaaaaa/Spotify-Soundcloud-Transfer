import test from 'node:test';
import assert from 'node:assert/strict';
import { expandedQueries, hardBlock, selectAggressive } from '../server/aggressive.js';
import type { Mapping, SoundCloudTrack, SpotifyTrack } from '../shared/types.js';

const source: SpotifyTrack = {
  id: 's1',
  title: 'Midnight Song',
  artists: ['Artist'],
  album: '',
  duration_ms: 200000,
  isrc: 'USABC1234567',
  url: null,
};
const target: SoundCloudTrack = {
  urn: 'soundcloud:tracks:1',
  title: 'Artist - Midnight Song',
  duration: 200000,
  isrc: 'USABC1234567',
  metadata_artist: 'Artist',
  user: { username: 'Artist' },
  permalink_url: null,
};
const previous: Mapping = {
  spotifyTrackId: 's1',
  status: 'REVIEW',
  matchMethod: null,
  score: null,
  reasons: [],
  matcherVersion: '2.0.0',
  candidates: [],
  acceptedUrn: null,
  decision: 'pending',
  processedAt: '2026-01-01T00:00:00Z',
};

test('REVIEW auto-picks highest eligible score', () => {
  const weak = { ...target, urn: 'soundcloud:tracks:2', title: 'Artist - Midnight', isrc: null };
  const result = selectAggressive(source, previous, [weak, target]);
  assert.equal(result.status, 'AUTO_BEST_MATCH');
  assert.equal(result.acceptedUrn, target.urn);
  assert.equal(result.selectedSoundCloudUrn, target.urn);
  assert.equal(result.matchMethod, 'AGGRESSIVE_BEST_MATCH');
  assert.equal(result.aggressive, true);
});

test('ambiguity and equal scores resolve by duration then stable URN', () => {
  const withoutIsrc = { ...source, isrc: null };
  const a = { ...target, urn: 'soundcloud:tracks:3', isrc: null, duration: 200100 };
  const b = { ...target, urn: 'soundcloud:tracks:2', isrc: null, duration: 200200 };
  assert.equal(selectAggressive(withoutIsrc, previous, [b, a]).acceptedUrn, a.urn);
  const c = { ...a, urn: 'soundcloud:tracks:1' };
  assert.equal(selectAggressive(withoutIsrc, previous, [a, c]).acceptedUrn, c.urn);
});

test('hard rules reject conflicting ISRC, new version semantics, and extreme duration', () => {
  const variants = [
    { ...target, isrc: 'GBXYZ1234567' },
    ...[
      'Remix',
      'Sped Up',
      'Slowed',
      'Slowed + Reverb',
      'Nightcore',
      'Cover',
      'Live',
      'Instrumental',
      'Karaoke',
      'Mashup',
      'Bootleg',
    ].map((version) => ({ ...target, title: `Artist - Midnight Song (${version})` })),
    { ...target, duration: 250001 },
  ];
  for (const variant of variants) assert.ok(hardBlock(source, variant), variant.title);
  const result = selectAggressive(source, previous, variants);
  assert.equal(result.status, 'HARD_REJECTED_ALL');
  assert.equal(result.acceptedUrn, null);
});

test('normal duration difference and radio edit remain eligible', () => {
  assert.equal(hardBlock(source, { ...target, duration: 215000 }), null);
  const radio = { ...target, title: 'Artist - Midnight Song (Radio Edit)', isrc: null };
  assert.equal(hardBlock(source, radio), null);
  assert.equal(selectAggressive(source, previous, [radio]).status, 'AUTO_BEST_MATCH');
});

test('no candidates remains NOT_FOUND with explicit skip reason', () => {
  const result = selectAggressive(source, { ...previous, status: 'NOT_FOUND' }, []);
  assert.equal(result.status, 'NOT_FOUND');
  assert.deepEqual(result.reasons, ['SKIPPED_NO_CANDIDATE']);
});

test('extended queries include exact title and variants without feat/version suffix', () => {
  const queries = expandedQueries({ ...source, title: 'Midnight Song feat. Ana (Radio Edit)' });
  assert.equal(queries[0], 'Artist Midnight Song feat. Ana (Radio Edit)');
  assert.ok(queries.includes('Midnight Song feat. Ana (Radio Edit)'));
  assert.ok(queries.includes('Midnight Song'));
  assert.equal(new Set(queries).size, queries.length);
});
