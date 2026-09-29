import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStableUniqueReadback,
  mismatchReport,
  mismatchStatus,
  stableUnique,
} from '../server/playlist-verification.js';
import type { PlaylistPlan, SoundCloudTrack } from '../shared/types.js';

const urn = (n: number) => `soundcloud:tracks:${n}`;
const track = (n: number, access = 'playable'): SoundCloudTrack => ({
  urn: urn(n),
  title: `Track ${n}`,
  duration: 1000,
  isrc: null,
  metadata_artist: null,
  user: {},
  permalink_url: null,
  access,
});
const item = (urns: string[]): PlaylistPlan => ({
  key: 'p:0',
  sourceId: 'p',
  title: 'Playlist',
  urns,
});

test('exact read-back returns no mismatch after full pagination', () => {
  assert.equal(
    mismatchReport(item([urn(1), urn(2)]), 'soundcloud:playlists:1', [track(1), track(2)], 2),
    null,
  );
});

test('count mismatch report gives first shift, missing multiset and pages', () => {
  const report = mismatchReport(
    item([urn(1), urn(2), urn(3)]),
    'soundcloud:playlists:1',
    [track(1), track(3)],
    2,
  )!;
  assert.equal(report.plannedCount, 3);
  assert.equal(report.actualCount, 2);
  assert.equal(report.pagesRead, 2);
  assert.equal(report.firstMismatchIndex, 1);
  assert.equal(report.expectedUrn, urn(2));
  assert.equal(report.actualUrn, urn(3));
  assert.deepEqual(report.missingUrns, [urn(2)]);
  assert.deepEqual(report.unexpectedUrns, []);
  assert.equal(
    mismatchStatus(item([urn(1), urn(2), urn(3)]), [track(1), track(3)]),
    'COUNT_MISMATCH',
  );
});

test('order mismatch reports equal multisets and first differing index', () => {
  const plan = item([urn(1), urn(2)]);
  const actual = [track(2), track(1)];
  const report = mismatchReport(plan, 'soundcloud:playlists:1', actual, 1)!;
  assert.equal(report.firstMismatchIndex, 0);
  assert.equal(report.expectedUrn, urn(1));
  assert.equal(report.actualUrn, urn(2));
  assert.deepEqual(report.missingUrns, []);
  assert.deepEqual(report.unexpectedUrns, []);
  assert.equal(mismatchStatus(plan, actual), 'ORDER_MISMATCH');
});

test('duplicate planned occurrence is diagnosed without deduplicating the plan', () => {
  const plan = item([urn(1), urn(2), urn(1)]);
  const actual = [track(1, 'preview'), track(2)];
  const report = mismatchReport(plan, 'soundcloud:playlists:1', actual, 1)!;
  assert.deepEqual(report.duplicatePlannedUrns, [{ urn: urn(1), positions: [0, 2] }]);
  assert.deepEqual(report.missingUrns, [urn(1)]);
  assert.equal(report.firstMismatchIndex, 2);
  assert.equal(report.actualUrn, null);
  assert.equal(report.accessCounts.preview, 1);
  assert.equal(mismatchStatus(plan, actual), 'UNSUPPORTED_DUPLICATE_OCCURRENCES');
});

test('staging and ordinary playlists share the strict stable-unique duplicate rule', () => {
  const ordinary = item([urn(1), urn(2), urn(1)]);
  const staging = { ...ordinary, key: 'likes:0', sourceId: null, title: 'Spotify Likes 001' };
  assert.deepEqual(stableUnique(ordinary.urns), [urn(1), urn(2)]);
  assert.equal(mismatchStatus(ordinary, [track(1), track(2)]), 'UNSUPPORTED_DUPLICATE_OCCURRENCES');
  assert.equal(mismatchStatus(staging, [track(1), track(2)]), 'UNSUPPORTED_DUPLICATE_OCCURRENCES');
  assert.equal(isStableUniqueReadback(staging.urns, [urn(1), urn(2)]), true);
});

test('duplicate fallback rejects missing unique, reordered and unexpected read-backs', () => {
  const planned = [urn(1), urn(2), urn(1)];
  assert.equal(isStableUniqueReadback(planned, [urn(1)]), false);
  assert.equal(isStableUniqueReadback(planned, [urn(2), urn(1)]), false);
  assert.equal(isStableUniqueReadback(planned, [urn(1), urn(2), urn(3)]), false);
  assert.equal(
    mismatchStatus(item(planned), [track(1), track(2), track(3), track(4)]),
    'COUNT_MISMATCH',
  );
});
