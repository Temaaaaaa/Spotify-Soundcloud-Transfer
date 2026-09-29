import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoveryIsNewer, Workflow } from '../server/workflow.js';
import { soundcloud, soundCloudApi } from '../server/providers.js';
import { ApiError, UnknownOutcome } from '../server/http.js';
import { loadJson, saveJson, StorageError } from '../server/storage.js';
import { PlaylistMismatchError } from '../server/playlist-verification.js';
import type {
  Journal,
  MigrationPlan,
  SoundCloudBackup,
  SpotifySnapshot,
  SoundCloudTrack,
  Discovery,
} from '../shared/types.js';

const track = (urn: string): SoundCloudTrack => ({
  urn,
  title: urn,
  duration: 1000,
  isrc: null,
  metadata_artist: null,
  user: { username: 'u' },
  permalink_url: null,
});

test('discovery checkpoint failure blocks job without an unhandled rejection', async () => {
  const w = setup();
  w.plan = null;
  w.snapshot!.tracks.s1.unavailable = true;
  (w as any).saveDiscovery = async () => {
    throw new StorageError(
      'checkpoint.json',
      'checkpoint.json.id.tmp',
      'EPERM',
      10,
      new Error('locked'),
    );
  };
  w.startDiscovery();
  for (let i = 0; w.job.running && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.job.running, false);
  assert.equal(w.discovery?.status, 'blocked');
  assert.match(w.job.error, /Storage write failed \(EPERM\)/);
});

test('restart restores strictly newer discovery temp for same snapshot', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'discovery-restart-')));
  try {
    const w = setup();
    const snapshot = w.snapshot!;
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const old: Discovery = {
      schemaVersion: 2,
      snapshotHash,
      status: 'running',
      error: null,
      mappings: {},
    };
    const newer: Discovery = {
      ...old,
      mappings: {
        s1: {
          spotifyTrackId: 's1',
          status: 'SOURCE_UNAVAILABLE',
          matchMethod: null,
          score: null,
          reasons: [],
          matcherVersion: '2.0.0',
          candidates: [],
          acceptedUrn: null,
          decision: 'pending',
          processedAt: '2024-01-01T00:00:00Z',
        },
      },
    };
    await writeFile('data/spotify-snapshot.json', JSON.stringify(snapshot)).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir('data', { recursive: true });
      await writeFile('data/spotify-snapshot.json', JSON.stringify(snapshot));
    });
    await writeFile('data/soundcloud-discovery.json', JSON.stringify(old));
    await writeFile(
      'data/soundcloud-discovery.json.00000000-0000-4000-8000-000000000001.tmp',
      JSON.stringify(newer),
    );
    const restored = new Workflow();
    await restored.init();
    assert.equal(
      Object.values(restored.discovery!.mappings).filter((m) => m.processedAt).length,
      1,
    );
    assert.equal(restored.discovery?.status, 'paused');
  } finally {
    process.chdir(previous);
  }
});

test('discovery recovery rejects a different source snapshot', () => {
  const snapshot = setup().snapshot!;
  const candidate: Discovery = {
    schemaVersion: 2,
    snapshotHash: 'other-snapshot',
    status: 'running',
    error: null,
    mappings: {},
  };
  assert.equal(discoveryIsNewer(candidate, null, snapshot), false);
});

test('completed discovery stale error is historical and cannot block resume', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'completed-discovery-stale-error-')));
  try {
    const source = setup().snapshot!;
    const discovery: Discovery = {
      schemaVersion: 2,
      snapshotHash: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      status: 'completed',
      error: 'Storage write failed (EPERM); recovery file no longer exists',
      mappings: {},
    };
    await saveJson('data/spotify-snapshot.json', source);
    await saveJson('data/soundcloud-discovery.json', discovery);
    const w = new Workflow();
    await w.init();
    assert.equal(w.currentDiscoveryError(), null);
    assert.match(w.historicalDiscoveryError() || '', /EPERM/);
    assert.equal(w.job.error, '');
    assert.equal(
      (
        await loadJson(
          'data/soundcloud-discovery.json',
          (v): v is Discovery => v?.status === 'completed',
        )
      )?.error,
      discovery.error,
    );
  } finally {
    process.chdir(previous);
  }
});

test('a future completed discovery run clears its error before checkpointing', async () => {
  const w = setup();
  w.discovery = {
    schemaVersion: 2,
    snapshotHash: createHash('sha256').update(JSON.stringify(w.snapshot)).digest('hex'),
    status: 'paused',
    error: 'old error',
    mappings: {},
  };
  (w as any).saveDiscovery = async () => {};
  (w as any).discoveryLoop = async () => {
    w.discovery!.status = 'completed';
    w.discovery!.error = null;
  };
  w.startDiscovery();
  for (let i = 0; w.job.running && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(w.discovery?.status, 'completed');
  assert.equal(w.discovery?.error, null);
});
function setup() {
  const snapshot: SpotifySnapshot = {
    schemaVersion: 2,
    createdAt: '2024-01-01',
    accountId: 'spotify',
    savedTracks: ['s1'],
    tracks: {
      s1: {
        id: 's1',
        title: 'Song',
        artists: ['A'],
        album: '',
        duration_ms: 1000,
        isrc: null,
        url: null,
        spotifyAddedAt: '2024-01-01T00:00:00Z',
      },
    },
    playlists: [],
  };
  const plan: MigrationPlan = {
    schemaVersion: 2,
    id: 'test',
    createdAt: '2024-01-01',
    snapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    targetAccountUrn: 'soundcloud:users:1',
    matcherVersion: '2.0.0',
    acceptedMappings: { s1: 'soundcloud:tracks:1' },
    existingLikes: [],
    plannedLikes: [
      { spotifyTrackId: 's1', urn: 'soundcloud:tracks:1', addedAt: '2024-01-01T00:00:00Z' },
    ],
    playlists: [
      { key: 'p:0', sourceId: 'p', title: 'Private playlist', urns: ['soundcloud:tracks:1'] },
    ],
    unsupported: [],
    notFound: [],
    backupFile: 'data/backups/test.json',
  };
  const backup: SoundCloudBackup = {
    schemaVersion: 2,
    accountUrn: 'soundcloud:users:1',
    username: 'u',
    createdAt: '2024-01-01',
    complete: true,
    likes: [],
    playlists: [],
  };
  const journal: Journal = {
    schemaVersion: 2,
    planId: 'test',
    accountUrn: 'soundcloud:users:1',
    playlists: {},
    likes: {},
    status: 'idle',
    likeOrder: 'newest-first',
  };
  const workflow = new Workflow();
  Object.assign(workflow, { snapshot, plan, backup, journal });
  return workflow;
}

test('aggressive mode reuses VERIFIED, searches NOT_FOUND with GET, persists separately and prepares plan', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'aggressive-workflow-')));
  const old = {
    search: soundCloudApi.search,
    me: soundCloudApi.me,
    like: soundCloudApi.like,
    unlike: soundCloudApi.unlike,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
    deletePlaylist: soundCloudApi.deletePlaylist,
  };
  let searches = 0;
  let writes = 0;
  const scTrack = (urn: string, title: string, artist: string): SoundCloudTrack => ({
    urn,
    title,
    duration: 1000,
    isrc: null,
    metadata_artist: artist,
    user: { username: artist },
    permalink_url: null,
  });
  (soundCloudApi as any).search = async (query: string) => {
    searches++;
    return query === 'Hidden' ? [scTrack('soundcloud:tracks:3', 'C - Hidden', 'C')] : [];
  };
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  for (const method of ['like', 'unlike', 'createPlaylist', 'updatePlaylist', 'deletePlaylist'])
    (soundCloudApi as any)[method] = async () => {
      writes++;
      throw new Error('SoundCloud write forbidden');
    };
  try {
    const w = setup();
    w.plan = null;
    w.backupFile = 'data/backups/test.json';
    w.snapshot!.tracks.s2 = { ...w.snapshot!.tracks.s1, id: 's2', title: 'Other', artists: ['B'] };
    w.snapshot!.tracks.s3 = { ...w.snapshot!.tracks.s1, id: 's3', title: 'Hidden', artists: ['C'] };
    const verified = {
      spotifyTrackId: 's1',
      status: 'VERIFIED' as const,
      matchMethod: 'METADATA' as const,
      score: 95,
      reasons: [],
      matcherVersion: '2.0.0',
      candidates: [],
      acceptedUrn: 'soundcloud:tracks:1',
      decision: 'pending' as const,
      processedAt: '2026-01-01T00:00:00Z',
    };
    const review = {
      ...verified,
      spotifyTrackId: 's2',
      status: 'REVIEW' as const,
      acceptedUrn: null,
      candidates: [
        {
          track: scTrack('soundcloud:tracks:2', 'B - Other', 'B'),
          score: 75,
          category: 'REVIEW' as const,
          reasons: [],
          components: { title: 40, artist: 25, duration: 15, isrc: 0, penalties: 0 },
        },
      ],
    };
    const notFound = {
      ...verified,
      spotifyTrackId: 's3',
      status: 'NOT_FOUND' as const,
      acceptedUrn: null,
      candidates: [],
    };
    w.discovery = {
      schemaVersion: 2,
      snapshotHash: createHash('sha256').update(JSON.stringify(w.snapshot)).digest('hex'),
      status: 'completed',
      error: null,
      mappings: { s1: verified, s2: review, s3: notFound },
    };
    await saveJson('data/spotify-snapshot.json', w.snapshot);
    await saveJson('data/soundcloud-discovery.json', w.discovery);
    const strictBefore = await readFile('data/soundcloud-discovery.json', 'utf8');
    const offline = await w.autoPickReviewsOffline();
    assert.equal(offline?.reviewAuto, 1);
    assert.equal(w.aggressive?.status, 'paused');
    assert.equal(w.aggressive?.overrides.s3, undefined);
    assert.equal(searches, 0);
    w.startAggressive();
    for (let i = 0; w.job.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.job.running, false);
    assert.equal(w.aggressive?.status, 'completed', w.job.error);
    assert.equal(w.aggressive?.schemaVersion, 3);
    assert.equal(w.aggressive?.overrides.s1, undefined);
    assert.equal(w.aggressive?.overrides.s2.status, 'AUTO_BEST_MATCH');
    assert.equal(w.aggressive?.overrides.s3.status, 'AUTO_BEST_MATCH');
    assert.ok(searches >= 2);
    assert.equal(writes, 0);
    assert.equal(await readFile('data/soundcloud-discovery.json', 'utf8'), strictBefore);
    const restarted = new Workflow();
    await restarted.init();
    assert.equal(restarted.matchingMode, 'AGGRESSIVE_BEST_MATCH');
    assert.equal(restarted.activeDiscovery()?.mappings.s1.acceptedUrn, verified.acceptedUrn);
    assert.equal(restarted.activeDiscovery()?.mappings.s3.status, 'AUTO_BEST_MATCH');
    restarted.setMatchingMode('STRICT');
    assert.equal(restarted.job.done, 3);
    assert.equal(restarted.job.total, 3);
    restarted.setMatchingMode('AGGRESSIVE_BEST_MATCH');
    assert.equal(restarted.job.done, 2);
    assert.equal(restarted.job.total, 2);
    const plan = await w.prepare();
    assert.deepEqual(plan.mappingSummary, { verified: 1, aggressive: 2, skipped: 0 });
    assert.equal(Object.keys(plan.acceptedMappings).length, 3);
    assert.equal(plan.matchingMode, 'AGGRESSIVE_BEST_MATCH');
    assert.equal(writes, 0);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
test('playlist payload uses private sharing and URN track objects', async () => {
  const old = soundcloud.request;
  let body: any;
  (soundcloud as any).request = async (_p: string, _m: string, b: any) => {
    body = b;
    return { urn: 'soundcloud:playlists:1' };
  };
  try {
    await soundCloudApi.createPlaylist('Test', ['soundcloud:tracks:1']);
    assert.deepEqual(body, {
      playlist: { title: 'Test', sharing: 'private', tracks: [{ urn: 'soundcloud:tracks:1' }] },
    });
  } finally {
    (soundcloud as any).request = old;
  }
});
test('playlist execution verifies read-back and does not replay unknown POST', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'migration-workflow-')));
  const old = {
    me: soundCloudApi.me,
    createPlaylist: soundCloudApi.createPlaylist,
    playlistTracks: soundCloudApi.playlistTracks,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlists: soundCloudApi.playlists,
  };
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    throw new UnknownOutcome();
  };
  (soundCloudApi as any).playlists = async () => [
    { urn: 'soundcloud:playlists:1', title: 'Private playlist' },
  ];
  (soundCloudApi as any).playlistTracks = async () => [track('soundcloud:tracks:1')];
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1')],
    pagesRead: 1,
  });
  try {
    const w = setup();
    await w.executePlaylists('PLAYLISTS test', 1);
    assert.equal(posts, 1);
    assert.equal(w.journal!.playlists['p:0'].verified, true);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
test('429 pauses Like queue and unknown POST is read back before checkpoint', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'migration-likes-')));
  const old = { me: soundCloudApi.me, likes: soundCloudApi.likes, like: soundCloudApi.like };
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => [];
  (soundCloudApi as any).like = async () => {
    throw new ApiError(429, 'soundcloud');
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: true };
    await w.executeLikes('LIKES test');
    assert.equal(w.journal!.status, 'RATE_LIMITED');
    assert.equal(w.journal!.rateLimit?.upstreamStatus, 429);
    assert.equal(w.journal!.rateLimit?.retryAt, null);
    let liked = false;
    (soundCloudApi as any).like = async () => {
      liked = true;
      throw new UnknownOutcome();
    };
    (soundCloudApi as any).likes = async () => (liked ? [track('soundcloud:tracks:1')] : []);
    await w.executeLikes('LIKES test');
    assert.equal(w.journal!.likes['soundcloud:tracks:1'].stateAfter, 'PRESENT');
    assert.equal(w.journal!.status, 'completed');
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
test('unresolved playlist POST remains UNKNOWN and never replays on resume', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'migration-unknown-')));
  const old = {
    me: soundCloudApi.me,
    createPlaylist: soundCloudApi.createPlaylist,
    playlistTracks: soundCloudApi.playlistTracks,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlists: soundCloudApi.playlists,
  };
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    throw new UnknownOutcome();
  };
  (soundCloudApi as any).playlists = async () => [];
  try {
    const w = setup();
    await assert.rejects(w.executePlaylists('PLAYLISTS test'), UnknownOutcome);
    assert.equal(w.journal!.status, 'UNKNOWN');
    await assert.rejects(w.executePlaylists('PLAYLISTS test'), UnknownOutcome);
    assert.equal(posts, 1);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
test('restart with in-flight playlist performs read-back before any POST', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'migration-restart-')));
  const old = {
    me: soundCloudApi.me,
    createPlaylist: soundCloudApi.createPlaylist,
    playlistTracks: soundCloudApi.playlistTracks,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlists: soundCloudApi.playlists,
  };
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    throw new Error('must not post');
  };
  (soundCloudApi as any).playlists = async () => [
    { urn: 'soundcloud:playlists:1', title: 'Private playlist' },
  ];
  (soundCloudApi as any).playlistTracks = async () => [track('soundcloud:tracks:1')];
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1')],
    pagesRead: 1,
  });
  try {
    const w = setup();
    w.journal!.unknownPlaylistKey = 'p:0';
    await w.executePlaylists('PLAYLISTS test');
    assert.equal(posts, 0);
    assert.equal(w.journal!.playlists['p:0'].verified, true);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
test('playlist order mismatch stops further writes', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'migration-order-')));
  const old = {
    me: soundCloudApi.me,
    createPlaylist: soundCloudApi.createPlaylist,
    playlistTracks: soundCloudApi.playlistTracks,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlistWithTracks: soundCloudApi.playlistWithTracks,
    track: soundCloudApi.track,
  };
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    return { urn: 'soundcloud:playlists:1' };
  };
  (soundCloudApi as any).playlistTracks = async () => [];
  (soundCloudApi as any).playlistTracksDetailed = async () => ({ tracks: [], pagesRead: 1 });
  (soundCloudApi as any).playlistWithTracks = async () => ({ tracks: [] });
  (soundCloudApi as any).track = async (urn: string) => track(urn);
  try {
    const w = setup();
    await assert.rejects(w.executePlaylists('PLAYLISTS test'), /MISMATCH/);
    assert.equal(posts, 1);
    assert.equal(w.journal!.playlists['p:0'].verified, false);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('missing blocked track produces access diagnostic without retrying PUT or POST', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'playlist-blocked-')));
  const old = {
    me: soundCloudApi.me,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlistWithTracks: soundCloudApi.playlistWithTracks,
    track: soundCloudApi.track,
    updatePlaylist: soundCloudApi.updatePlaylist,
    createPlaylist: soundCloudApi.createPlaylist,
  };
  let writes = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).playlistTracksDetailed = async () => ({ tracks: [], pagesRead: 2 });
  (soundCloudApi as any).playlistWithTracks = async () => ({ tracks: [] });
  (soundCloudApi as any).track = async (urn: string) => ({ ...track(urn), access: 'blocked' });
  (soundCloudApi as any).updatePlaylist = async () => {
    writes++;
  };
  (soundCloudApi as any).createPlaylist = async () => {
    writes++;
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: false };
    await assert.rejects(w.executePlaylists('PLAYLISTS test'), (e: any) => {
      assert.ok(e instanceof PlaylistMismatchError);
      assert.equal(e.report.pagesRead, 2);
      assert.deepEqual(e.report.missingUrns, ['soundcloud:tracks:1']);
      assert.equal(e.report.missingTrackDetails[0].access, 'blocked');
      return true;
    });
    assert.equal(writes, 0);
    assert.equal(w.journal!.playlists['p:0'].verified, false);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('resume validates seven verified playlists and reuses the eighth saved URN', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'playlist-seven-')));
  const old = {
    me: soundCloudApi.me,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
  };
  let readbacks = 0,
    posts = 0,
    puts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).playlistTracksDetailed = async () => {
    readbacks++;
    return { tracks: [track('soundcloud:tracks:1')], pagesRead: 1 };
  };
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    throw new Error('duplicate POST');
  };
  (soundCloudApi as any).updatePlaylist = async () => {
    puts++;
    throw new Error('unexpected PUT');
  };
  try {
    const w = setup();
    w.plan!.playlists = Array.from({ length: 8 }, (_, i) => ({
      key: `p:${i}`,
      sourceId: `p${i}`,
      title: `Playlist ${i}`,
      urns: ['soundcloud:tracks:1'],
    }));
    for (let i = 0; i < 8; i++)
      w.journal!.playlists[`p:${i}`] = {
        urn: `soundcloud:playlists:${i + 1}`,
        verified: i < 7,
      };
    await w.executePlaylists('PLAYLISTS test');
    assert.equal(readbacks, 8);
    assert.equal(posts, 0);
    assert.equal(puts, 0);
    assert.equal(Object.values(w.journal!.playlists).filter((p) => p.verified).length, 8);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('existing failed-created playlist is repaired with PUT to saved URN, never POSTed again', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'playlist-repair-')));
  const old = {
    me: soundCloudApi.me,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlistWithTracks: soundCloudApi.playlistWithTracks,
    track: soundCloudApi.track,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
  };
  let posts = 0,
    puts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: puts ? [track('soundcloud:tracks:1')] : [],
    pagesRead: 1,
  });
  (soundCloudApi as any).playlistWithTracks = async () => ({ tracks: [] });
  (soundCloudApi as any).track = async (urn: string) => track(urn);
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    throw new Error('duplicate POST');
  };
  (soundCloudApi as any).updatePlaylist = async (urn: string) => {
    assert.equal(urn, 'soundcloud:playlists:77');
    puts++;
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:77', verified: false };
    await w.executePlaylists('PLAYLISTS test');
    assert.equal(posts, 0);
    assert.equal(puts, 1);
    assert.equal(w.journal!.playlists['p:0'].verified, true);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('duplicate loss stays blocked until exact confirmation and records lost position', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'playlist-duplicates-')));
  const old = {
    me: soundCloudApi.me,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlistWithTracks: soundCloudApi.playlistWithTracks,
    track: soundCloudApi.track,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
  };
  let writes = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1'), track('soundcloud:tracks:2')],
    pagesRead: 1,
  });
  (soundCloudApi as any).playlistWithTracks = async () => ({
    tracks: [{ urn: 'soundcloud:tracks:1' }, { urn: 'soundcloud:tracks:2' }],
  });
  (soundCloudApi as any).track = async (urn: string) => ({ ...track(urn), access: 'preview' });
  (soundCloudApi as any).createPlaylist = async () => {
    writes++;
  };
  (soundCloudApi as any).updatePlaylist = async () => {
    writes++;
  };
  try {
    const w = setup();
    w.plan!.playlists[0].urns = [
      'soundcloud:tracks:1',
      'soundcloud:tracks:2',
      'soundcloud:tracks:1',
    ];
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:77', verified: false };
    await assert.rejects(
      w.executePlaylists('PLAYLISTS test'),
      (e: any) =>
        e instanceof PlaylistMismatchError && e.status === 'UNSUPPORTED_DUPLICATE_OCCURRENCES',
    );
    assert.equal(writes, 0);
    await assert.rejects(w.acceptDuplicateFallback('p:0', 'wrong'), /confirmation/);
    assert.equal(w.journal!.playlists['p:0'].verified, false);
    const result = await w.acceptDuplicateFallback('p:0', 'ACCEPT DUPLICATE LOSS test p:0');
    assert.deepEqual(result.lostPositions, [{ urn: 'soundcloud:tracks:1', position: 2 }]);
    assert.equal(w.journal!.playlists['p:0'].verified, true);
    await w.executePlaylists('PLAYLISTS test');
    assert.equal(writes, 0);
    const audit = JSON.parse(
      await readFile(`data/audit/${(await readdir('data/audit'))[0]}`, 'utf8'),
    );
    assert.deepEqual(audit.lostPositions, result.lostPositions);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('one guided action verifies a playlist, selects safe Like test tracks and finishes', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'guided-transfer-')));
  const old = {
    me: soundCloudApi.me,
    likes: soundCloudApi.likes,
    like: soundCloudApi.like,
    createPlaylist: soundCloudApi.createPlaylist,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
  };
  const liked: string[] = [];
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => liked.map(track);
  (soundCloudApi as any).like = async (urn: string) => {
    liked.unshift(urn);
  };
  (soundCloudApi as any).createPlaylist = async () => {
    posts++;
    return { urn: 'soundcloud:playlists:1' };
  };
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1')],
    pagesRead: 1,
  });
  try {
    const w = setup();
    w.plan!.plannedLikes.push({ spotifyTrackId: 's2', urn: 'soundcloud:tracks:2', addedAt: null });
    w.journal!.likeOrder = 'unknown';
    await w.startGuidedTransfer();
    for (let i = 0; w.guided.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.guided.error, '');
    assert.equal(w.guided.phase, 'done');
    assert.equal(w.journal!.status, 'completed');
    assert.equal(w.journal!.playlists['p:0'].verified, true);
    assert.equal(posts, 1);
    assert.deepEqual(new Set(liked), new Set(['soundcloud:tracks:1', 'soundcloud:tracks:2']));
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('guided resume accepts diagnosed duplicate loss and reuses existing playlist', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'guided-duplicate-')));
  const old = {
    me: soundCloudApi.me,
    likes: soundCloudApi.likes,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    playlistWithTracks: soundCloudApi.playlistWithTracks,
    track: soundCloudApi.track,
  };
  let writes = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => [];
  (soundCloudApi as any).createPlaylist = async () => {
    writes++;
    throw new Error('duplicate POST');
  };
  (soundCloudApi as any).updatePlaylist = async () => {
    writes++;
    throw new Error('unexpected PUT');
  };
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1')],
    pagesRead: 1,
  });
  (soundCloudApi as any).playlistWithTracks = async () => ({
    tracks: [{ urn: 'soundcloud:tracks:1' }],
  });
  (soundCloudApi as any).track = async (urn: string) => track(urn);
  try {
    const w = setup();
    w.plan!.plannedLikes = [];
    w.plan!.playlists[0].urns = ['soundcloud:tracks:1', 'soundcloud:tracks:1'];
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:7', verified: false };
    w.journal!.status = 'paused';
    w.journal!.likeOrder = 'unknown';
    await w.startGuidedTransfer();
    for (let i = 0; w.guided.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.guided.error, '');
    assert.equal(w.journal!.status, 'completed');
    assert.equal(w.journal!.playlists['p:0'].duplicateFallbackAccepted, true);
    assert.equal(writes, 0);
    const files = await readdir('data/audit');
    assert.equal(files.filter((f) => f.startsWith('duplicate-fallback')).length, 1);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('guided Like phase ignores ambiguous staging playlists and preserves source verification', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'guided-staging-best-effort-')));
  const old = {
    me: soundCloudApi.me,
    likes: soundCloudApi.likes,
    playlistTracksDetailed: soundCloudApi.playlistTracksDetailed,
    createPlaylist: soundCloudApi.createPlaylist,
    updatePlaylist: soundCloudApi.updatePlaylist,
    like: soundCloudApi.like,
  };
  let writes = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => [];
  (soundCloudApi as any).playlistTracksDetailed = async () => ({
    tracks: [track('soundcloud:tracks:1')],
    pagesRead: 1,
  });
  for (const method of ['createPlaylist', 'updatePlaylist', 'like'])
    (soundCloudApi as any)[method] = async () => {
      writes++;
      throw new Error('write forbidden');
    };
  try {
    const w = setup();
    w.plan!.plannedLikes = [];
    w.plan!.playlists.push({
      key: 'likes:0',
      sourceId: null,
      kind: 'LIKES_STAGING',
      title: 'Spotify Likes 001',
      urns: ['soundcloud:tracks:1', 'soundcloud:tracks:1'],
    });
    w.plan!.playlists.push({
      key: 'likes:1',
      sourceId: null,
      kind: 'LIKES_STAGING',
      title: 'Spotify Likes 002',
      urns: ['soundcloud:tracks:1'],
    });
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:source', verified: true };
    w.journal!.playlists['likes:0'] = {
      urn: 'soundcloud:playlists:staging',
      verified: false,
      verificationStatus: 'COUNT_MISMATCH',
      mismatch: {
        playlistName: 'Spotify Likes 001',
        playlistUrn: 'soundcloud:playlists:staging',
        plannedCount: 500,
        actualCount: 499,
        pagesRead: 2,
        duplicatePlannedUrns: [],
        firstMismatchIndex: 459,
        expectedUrn: 'soundcloud:tracks:1',
        actualUrn: 'soundcloud:tracks:2',
        missingUrns: [],
        unexpectedUrns: [],
        accessCounts: {},
        missingTrackDetails: [],
        showTracksCount: 498,
        showTracksMatchesReadBack: false,
      },
    };
    await w.startGuidedTransfer();
    for (let i = 0; w.guided.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.guided.error, '');
    assert.equal(w.guided.phase, 'done');
    assert.equal(w.journal!.playlists['p:0'].verified, true);
    assert.equal(w.journal!.playlists['likes:0'].stagingStatus, 'PARTIAL');
    assert.equal(w.journal!.playlists['likes:1'].stagingStatus, 'SKIPPED');
    assert.equal(w.journal!.status, 'completed');
    assert.equal(writes, 0);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('Likes persistence failure pauses with storage status and never rewrites discovery', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'likes-storage-error-')));
  const old = { me: soundCloudApi.me, likes: soundCloudApi.likes, like: soundCloudApi.like };
  let posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => [];
  (soundCloudApi as any).like = async () => {
    posts++;
  };
  try {
    const w = setup();
    w.plan!.playlists[0] = { ...w.plan!.playlists[0], kind: 'SOURCE_PLAYLIST' };
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: true };
    w.journal!.likeOrder = 'newest-first';
    await saveJson('data/soundcloud-discovery.json', { schemaVersion: 2, immutable: true });
    const before = await readFile('data/soundcloud-discovery.json', 'utf8');
    let saves = 0;
    (w as any).saveJournal = async () => {
      saves++;
      if (saves > 1)
        throw new StorageError(
          'data/operations/test.json',
          'data/operations/test.tmp',
          'EPERM',
          3,
          new Error('locked'),
        );
    };
    await assert.rejects(w.executeLikes('LIKES test'), StorageError);
    assert.equal(w.journal!.status, 'PAUSED_STORAGE_ERROR');
    assert.equal(w.job.running, false);
    assert.equal(posts, 1);
    assert.equal(await readFile('data/soundcloud-discovery.json', 'utf8'), before);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('explicit Resume clears legacy RATE_LIMITED, reconciles Likes, and posts only the next missing track', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'likes-resume-reconcile-')));
  const old = { me: soundCloudApi.me, likes: soundCloudApi.likes, like: soundCloudApi.like };
  const already = 'soundcloud:tracks:1',
    next = 'soundcloud:tracks:2';
  const present = new Set([already]);
  let reads = 0;
  const posts: string[] = [];
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => {
    reads++;
    return [...present].map(track);
  };
  (soundCloudApi as any).like = async (urn: string) => {
    posts.push(urn);
    present.add(urn);
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: true };
    w.journal!.status = 'RATE_LIMITED';
    w.plan!.plannedLikes.push({ spotifyTrackId: 's2', urn: next, addedAt: null });
    const response = await w.startGuidedTransfer();
    assert.deepEqual(response, {
      ok: true,
      state: 'RESUMING',
      previousStatus: 'RATE_LIMITED',
      retryAt: null,
    });
    for (let i = 0; w.guided.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.journal!.status, 'completed');
    assert.equal(w.journal!.likes[already].requestOutcome, 'SUCCESS_ALREADY_PRESENT');
    assert.equal(w.journal!.likes[next].stateAfter, 'PRESENT');
    assert.deepEqual(posts, [next]);
    assert.ok(reads >= 1);
    assert.equal(
      Object.values(w.journal!.likes).filter((op) => op.stateAfter === 'PRESENT').length,
      2,
    );
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});

test('future retryAt keeps RATE_LIMITED without Like read-back or POST', async () => {
  const old = { me: soundCloudApi.me, likes: soundCloudApi.likes, like: soundCloudApi.like };
  let reads = 0,
    posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => {
    reads++;
    return [];
  };
  (soundCloudApi as any).like = async () => {
    posts++;
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: true };
    w.journal!.status = 'RATE_LIMITED';
    w.journal!.rateLimit = {
      detectedAt: new Date().toISOString(),
      retryAfterSeconds: 3600,
      retryAt: new Date(Date.now() + 3600000).toISOString(),
      upstreamStatus: 429,
    };
    const response = await w.startGuidedTransfer();
    assert.equal(response?.ok, false);
    assert.equal(response?.state, 'RATE_LIMITED');
    assert.ok((response?.retryAfterSeconds || 0) > 0);
    assert.equal(w.journal!.status, 'RATE_LIMITED');
    assert.equal(reads, 0);
    assert.equal(posts, 0);
  } finally {
    Object.assign(soundCloudApi, old);
  }
});

test('expired retryAt is retryable and clears stale rate limit before reconciliation', async () => {
  const previous = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'likes-expired-retry-')));
  const old = { me: soundCloudApi.me, likes: soundCloudApi.likes, like: soundCloudApi.like };
  let reads = 0,
    posts = 0;
  (soundCloudApi as any).me = async () => ({ urn: 'soundcloud:users:1' });
  (soundCloudApi as any).likes = async () => {
    reads++;
    return [track('soundcloud:tracks:1')];
  };
  (soundCloudApi as any).like = async () => {
    posts++;
  };
  try {
    const w = setup();
    w.journal!.playlists['p:0'] = { urn: 'soundcloud:playlists:1', verified: true };
    w.journal!.status = 'RATE_LIMITED';
    w.journal!.rateLimit = {
      detectedAt: new Date(Date.now() - 60000).toISOString(),
      retryAfterSeconds: 1,
      retryAt: new Date(Date.now() - 30000).toISOString(),
      upstreamStatus: 429,
    };
    const response = await w.startGuidedTransfer();
    assert.equal(response?.state, 'RESUMING');
    assert.equal(response?.previousStatus, 'RATE_LIMITED');
    for (let i = 0; w.guided.running && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.journal!.status, 'completed');
    assert.equal(w.journal!.rateLimit, null);
    assert.ok(reads >= 1);
    assert.equal(posts, 0);
  } finally {
    Object.assign(soundCloudApi, old);
    process.chdir(previous);
  }
});
