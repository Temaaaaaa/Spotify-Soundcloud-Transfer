import { createHash, randomUUID } from 'node:crypto';
import type {
  AggressiveDiscovery,
  Discovery,
  Journal,
  Mapping,
  MatchingMode,
  MigrationPlan,
  Operation,
  PlaylistPlan,
  SoundCloudBackup,
  SpotifySnapshot,
  SpotifyTrack,
} from '../shared/types.js';
import { MATCHER_VERSION, normalize, rank } from './matcher.js';
import {
  AGGRESSIVE_MATCHER_VERSION,
  aggressiveSummary,
  expandedQueries,
  hardBlock,
  mergedDiscovery,
  selectAggressive,
} from './aggressive.js';
import { ApiError, UnknownOutcome } from './http.js';
import {
  duplicateOccurrences,
  isStableUniqueReadback,
  mismatchReport,
  mismatchStatus,
  PlaylistMismatchError,
} from './playlist-verification.js';
import { readSpotifySnapshot, soundCloudApi } from './providers.js';
import { loadJson, orphanTemps, recoverJson, saveJson, StorageError } from './storage.js';

const snapshotFile = 'data/spotify-snapshot.json';
const discoveryFile = 'data/soundcloud-discovery.json';
const aggressiveFile = 'data/soundcloud-discovery-aggressive.json';
const pointerFile = 'data/current-plan.json';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
const asSnapshot = (v: any): v is SpotifySnapshot =>
  v?.schemaVersion === 2 && v.tracks && Array.isArray(v.savedTracks) && Array.isArray(v.playlists);
const asDiscovery = (v: any): v is Discovery =>
  v?.schemaVersion === 2 &&
  typeof v.snapshotHash === 'string' &&
  ['idle', 'running', 'paused', 'completed', 'blocked'].includes(v.status) &&
  v.mappings &&
  typeof v.mappings === 'object' &&
  !Array.isArray(v.mappings) &&
  Object.entries(v.mappings).every(
    ([id, mapping]) =>
      (mapping as Mapping)?.spotifyTrackId === id &&
      (typeof (mapping as Mapping).processedAt === 'string' ||
        (mapping as Mapping).processedAt === null),
  );
const asAggressive = (v: any): v is AggressiveDiscovery =>
  v?.schemaVersion === 3 &&
  typeof v.snapshotHash === 'string' &&
  typeof v.sourceDiscoveryHash === 'string' &&
  ['running', 'paused', 'completed', 'blocked'].includes(v.status) &&
  v.overrides &&
  typeof v.overrides === 'object' &&
  !Array.isArray(v.overrides);

export function discoveryIsNewer(
  candidate: Discovery,
  current: Discovery | null,
  snapshot: SpotifySnapshot,
): boolean {
  if (candidate.snapshotHash !== hash(snapshot)) return false;
  if (Object.keys(candidate.mappings).some((id) => !snapshot.tracks[id])) return false;
  if (!current) return true;
  if (
    candidate.schemaVersion !== current.schemaVersion ||
    candidate.snapshotHash !== current.snapshotHash
  )
    return false;
  const old = Object.entries(current.mappings);
  if (
    old.some(([id, mapping]) => JSON.stringify(candidate.mappings[id]) !== JSON.stringify(mapping))
  )
    return false;
  const count = (d: Discovery) => Object.values(d.mappings).filter((m) => m.processedAt).length;
  return count(candidate) > count(current);
}
const asBackup = (v: any): v is SoundCloudBackup =>
  v?.schemaVersion === 2 &&
  typeof v.accountUrn === 'string' &&
  Array.isArray(v.likes) &&
  Array.isArray(v.playlists);
const asPlan = (v: any): v is MigrationPlan =>
  v?.schemaVersion === 2 && typeof v.id === 'string' && Array.isArray(v.playlists);
const asJournal = (v: any): v is Journal =>
  v?.schemaVersion === 2 && typeof v.planId === 'string' && v.playlists && v.likes;
function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
}
function isLikesStaging(item: PlaylistPlan) {
  return (
    item.kind === 'LIKES_STAGING' ||
    (item.sourceId === null && /^Spotify Likes \d{3}$/.test(item.title))
  );
}
function isSourcePlaylist(item: PlaylistPlan) {
  return !isLikesStaging(item);
}

export class Workflow {
  snapshot: SpotifySnapshot | null = null;
  discovery: Discovery | null = null;
  aggressive: AggressiveDiscovery | null = null;
  matchingMode: MatchingMode = 'STRICT';
  backup: SoundCloudBackup | null = null;
  backupFile: string | null = null;
  plan: MigrationPlan | null = null;
  journal: Journal | null = null;
  job = { running: false, done: 0, total: 0, error: '' };
  guided = { running: false, phase: 'idle', error: '', retryAt: null as string | null };
  private stop = false;
  private guidedStop = false;
  private resumePreviousStatus: Journal['status'] | null = null;
  private discoveryImmutable = false;
  async init() {
    this.snapshot = await loadJson(snapshotFile, asSnapshot);
    // Other checkpoint types have no monotonic progress proof; keep their orphans
    // for inspection instead of guessing which state should win.
    for (const file of [snapshotFile, pointerFile, 'data/current-backup.json'])
      for (const temp of await orphanTemps(file))
        console.warn(`Storage warning: recovery file ${temp} preserved`);
    this.discovery = this.snapshot
      ? await recoverJson(discoveryFile, asDiscovery, (candidate, current) =>
          discoveryIsNewer(candidate, current, this.snapshot!),
        )
      : await loadJson(discoveryFile, asDiscovery);
    if (this.discovery && (!this.snapshot || this.discovery.snapshotHash !== hash(this.snapshot)))
      this.discovery = null;
    if (this.snapshot && this.discovery) {
      const sourceDiscoveryHash = hash(this.discovery);
      this.aggressive = await recoverJson(
        aggressiveFile,
        asAggressive,
        (candidate, current) =>
          candidate.snapshotHash === hash(this.snapshot) &&
          candidate.sourceDiscoveryHash === sourceDiscoveryHash &&
          (!current ||
            (current.snapshotHash === candidate.snapshotHash &&
              current.sourceDiscoveryHash === candidate.sourceDiscoveryHash &&
              Object.entries(current.overrides).every(
                ([id, mapping]) =>
                  JSON.stringify(candidate.overrides[id]) === JSON.stringify(mapping),
              ) &&
              Object.keys(candidate.overrides).length > Object.keys(current.overrides).length)),
      );
      if (
        this.aggressive &&
        (this.aggressive.snapshotHash !== hash(this.snapshot) ||
          this.aggressive.sourceDiscoveryHash !== sourceDiscoveryHash)
      ) {
        console.warn(
          `Storage warning: incompatible aggressive checkpoint ${aggressiveFile} preserved`,
        );
        this.aggressive = null;
      }
      if (this.aggressive) {
        if (this.aggressive.status === 'running') this.aggressive.status = 'paused';
        this.matchingMode = 'AGGRESSIVE_BEST_MATCH';
      }
    }
    const pointer = await loadJson<{ file: string }>(
      pointerFile,
      (v): v is { file: string } =>
        typeof v?.file === 'string' && /^data\/migration-plan-[a-zA-Z0-9-]+\.json$/.test(v.file),
    );
    const backupPointer = await loadJson<{ file: string }>(
      'data/current-backup.json',
      (v): v is { file: string } =>
        typeof v?.file === 'string' && /^data\/backups\/soundcloud-\d{14}\.json$/.test(v.file),
    );
    if (backupPointer) {
      for (const temp of await orphanTemps(backupPointer.file))
        console.warn(`Storage warning: recovery file ${temp} preserved`);
      this.backupFile = backupPointer.file;
      this.backup = await loadJson(backupPointer.file, asBackup);
    }
    if (pointer) {
      for (const temp of await orphanTemps(pointer.file))
        console.warn(`Storage warning: recovery file ${temp} preserved`);
      this.plan = await loadJson(pointer.file, asPlan);
      if (!this.plan) throw new Error('Migration plan missing');
      this.backupFile = this.plan.backupFile;
      this.backup = await loadJson(this.plan.backupFile, asBackup);
      const journalFile = `data/operations/${this.plan.id}.json`;
      for (const temp of await orphanTemps(journalFile))
        console.warn(`Storage warning: recovery file ${temp} preserved`);
      this.journal = await loadJson(journalFile, asJournal);
      if (this.journal?.status === 'running') {
        this.journal.status = 'paused';
        await this.saveJournal();
      }
    }
    if (this.discovery?.status === 'running') {
      this.discovery.status = 'paused';
    }
    this.discoveryImmutable = this.discovery?.status === 'completed';
    if (this.snapshot && this.discovery) {
      this.job.done = this.aggressive
        ? Object.keys(this.aggressive.overrides).length
        : Object.values(this.discovery.mappings).filter((m) => m.processedAt).length;
      this.job.total = this.aggressive
        ? Object.values(this.discovery.mappings).filter(
            (m) => m.status === 'REVIEW' || m.status === 'NOT_FOUND',
          ).length
        : Object.keys(this.snapshot.tracks).length;
      this.job.error =
        this.aggressive?.error ||
        (this.discovery.status === 'completed' ? '' : this.discovery.error || '');
    }
  }
  activeDiscovery(): Discovery | null {
    return this.discovery && this.matchingMode === 'AGGRESSIVE_BEST_MATCH' && this.aggressive
      ? mergedDiscovery(this.discovery, this.aggressive)
      : this.discovery;
  }
  currentDiscoveryError() {
    return this.discovery && this.discovery.status !== 'completed' ? this.discovery.error : null;
  }
  historicalDiscoveryError() {
    return this.discovery?.status === 'completed' ? this.discovery.error : null;
  }
  setMatchingMode(mode: MatchingMode) {
    this.assertIdle();
    if (mode === 'AGGRESSIVE_BEST_MATCH' && !this.aggressive)
      throw new Error('Run Auto-pick best matches first');
    if (
      mode === 'AGGRESSIVE_BEST_MATCH' &&
      this.aggressive?.sourceDiscoveryHash !== hash(this.discovery)
    )
      throw new Error('Strict discovery changed; rerun Auto-pick best matches');
    this.matchingMode = mode;
    if (mode === 'AGGRESSIVE_BEST_MATCH' && this.discovery && this.aggressive) {
      this.job.done = Object.keys(this.aggressive.overrides).length;
      this.job.total = Object.values(this.discovery.mappings).filter(
        (m) => m.status === 'REVIEW' || m.status === 'NOT_FOUND',
      ).length;
      this.job.error = this.aggressive.error || '';
    } else if (this.discovery && this.snapshot) {
      this.job.done = Object.values(this.discovery.mappings).filter((m) => m.processedAt).length;
      this.job.total = Object.keys(this.snapshot.tracks).length;
      this.job.error = this.discovery.status === 'completed' ? '' : this.discovery.error || '';
    }
  }
  aggressivePreview() {
    if (!this.discovery || !this.snapshot) throw new Error('Discovery missing');
    const mappings = Object.values(this.discovery.mappings);
    return {
      verified: mappings.filter((m) => m.status === 'VERIFIED').length,
      reviewToAutoBestMatch: mappings.filter(
        (m) =>
          m.status === 'REVIEW' &&
          m.candidates.some((c) => !hardBlock(this.snapshot!.tracks[m.spotifyTrackId], c.track)),
      ).length,
      notFoundToResearch: mappings.filter((m) => m.status === 'NOT_FOUND').length,
    };
  }
  aggressiveSummary() {
    return this.discovery ? aggressiveSummary(this.discovery, this.aggressive) : null;
  }
  async autoPickReviewsOffline() {
    this.assertIdle();
    if (!this.snapshot || !this.discovery || this.discovery.status !== 'completed')
      throw new Error('Complete strict discovery first');
    if (this.plan) throw new Error('Existing migration plan is immutable');
    const sourceDiscoveryHash = hash(this.discovery);
    if (!this.aggressive || this.aggressive.sourceDiscoveryHash !== sourceDiscoveryHash) {
      this.aggressive = {
        schemaVersion: 3,
        snapshotHash: hash(this.snapshot),
        sourceDiscoveryHash,
        status: 'paused',
        error: null,
        overrides: {},
      };
    }
    for (const [id, mapping] of Object.entries(this.discovery.mappings)) {
      if (mapping.status !== 'REVIEW' || this.aggressive.overrides[id]) continue;
      this.aggressive.overrides[id] = selectAggressive(
        this.snapshot.tracks[id],
        mapping,
        mapping.candidates.map((c) => c.track),
      );
    }
    this.aggressive.status = 'paused';
    this.aggressive.error = null;
    await saveJson(aggressiveFile, this.aggressive);
    this.matchingMode = 'AGGRESSIVE_BEST_MATCH';
    this.job.done = Object.keys(this.aggressive.overrides).length;
    this.job.total = Object.values(this.discovery.mappings).filter(
      (m) => m.status === 'REVIEW' || m.status === 'NOT_FOUND',
    ).length;
    this.job.error = '';
    return this.aggressiveSummary();
  }
  startAggressive() {
    this.assertIdle();
    if (!this.snapshot || !this.discovery || this.discovery.status !== 'completed')
      throw new Error('Complete strict discovery first');
    if (this.plan) throw new Error('Existing migration plan is immutable');
    const sourceDiscoveryHash = hash(this.discovery);
    if (!this.aggressive || this.aggressive.sourceDiscoveryHash !== sourceDiscoveryHash) {
      this.aggressive = {
        schemaVersion: 3,
        snapshotHash: hash(this.snapshot),
        sourceDiscoveryHash,
        status: 'paused',
        error: null,
        overrides: {},
      };
    }
    this.matchingMode = 'AGGRESSIVE_BEST_MATCH';
    this.stop = false;
    this.job = {
      running: true,
      done: Object.keys(this.aggressive.overrides).length,
      total: Object.values(this.discovery.mappings).filter(
        (m) => m.status === 'REVIEW' || m.status === 'NOT_FOUND',
      ).length,
      error: '',
    };
    void this.runAggressiveSafely();
  }
  private async runAggressiveSafely() {
    try {
      await this.aggressiveLoop();
    } catch (e) {
      this.aggressive!.status = 'blocked';
      this.aggressive!.error = e instanceof Error ? e.message : 'Aggressive discovery failed';
      this.job.error = this.aggressive!.error;
      if (!(e instanceof StorageError)) {
        try {
          await saveJson(aggressiveFile, this.aggressive);
        } catch (saveError) {
          this.aggressive!.error =
            saveError instanceof Error ? saveError.message : 'Storage write failed';
          this.job.error = this.aggressive!.error;
        }
      }
    } finally {
      this.job.running = false;
    }
  }
  private async aggressiveLoop() {
    const strict = this.discovery!,
      snapshot = this.snapshot!,
      state = this.aggressive!;
    state.status = 'running';
    state.error = null;
    await saveJson(aggressiveFile, state);
    const entries = Object.entries(strict.mappings);
    for (const [id, original] of [
      ...entries.filter(([, mapping]) => mapping.status === 'REVIEW'),
      ...entries.filter(([, mapping]) => mapping.status === 'NOT_FOUND'),
    ]) {
      if (this.stop) break;
      if (original.status !== 'REVIEW' && original.status !== 'NOT_FOUND') continue;
      if (state.overrides[id]) continue;
      const track = snapshot.tracks[id];
      if (!track) throw new Error('Spotify snapshot changed');
      const found = new Map(original.candidates.map((c) => [c.track.urn, c.track]));
      if (original.status === 'NOT_FOUND') {
        for (const query of expandedQueries(track)) {
          if (this.stop) break;
          for (const candidate of await soundCloudApi.search(query, 25))
            found.set(candidate.urn, candidate);
        }
      }
      if (this.stop) break;
      state.overrides[id] = selectAggressive(track, original, [...found.values()]);
      this.job.done++;
      await saveJson(aggressiveFile, state);
    }
    state.status = this.stop ? 'paused' : 'completed';
    await saveJson(aggressiveFile, state);
  }
  private async saveDiscovery() {
    if (this.discoveryImmutable) return;
    await saveJson(discoveryFile, this.discovery);
  }
  private async saveJournal() {
    if (this.plan && this.journal)
      await saveJson(`data/operations/${this.plan.id}.json`, this.journal);
  }
  private assertIdle() {
    if (this.job.running) throw new Error('Another job is running');
  }
  async snapshotSpotify() {
    this.assertIdle();
    if (this.plan)
      throw new Error(
        'Existing migration plan is immutable; finish or explicitly reset it before a new snapshot',
      );
    const snapshot = await readSpotifySnapshot();
    await saveJson(snapshotFile, snapshot);
    this.snapshot = snapshot;
    this.discovery = null;
    return snapshot;
  }
  async backupSoundCloud() {
    this.assertIdle();
    if (this.plan) throw new Error('Existing plan uses its own immutable backup');
    const me = await soundCloudApi.me();
    if (typeof me?.urn !== 'string') throw new Error('SoundCloud /me has no URN');
    const backup: SoundCloudBackup = {
      schemaVersion: 2,
      accountUrn: me.urn,
      username: String(me.username || ''),
      createdAt: new Date().toISOString(),
      complete: false,
      likes: [],
      playlists: [],
    };
    const file = `data/backups/soundcloud-${stamp()}.json`;
    this.backupFile = file;
    await saveJson('data/current-backup.json', { file });
    await saveJson(file, backup);
    try {
      backup.likes = await soundCloudApi.likes();
      await saveJson(file, backup);
      const playlists = await soundCloudApi.playlists();
      for (const p of playlists) {
        if (typeof p?.urn !== 'string') throw new Error('Playlist URN missing');
        const tracks = await soundCloudApi.playlistTracks(p.urn);
        backup.playlists.push({ urn: p.urn, title: String(p.title || ''), tracks });
        await saveJson(file, backup);
      }
      backup.complete = true;
      await saveJson(file, backup);
      this.backup = backup;
      return { ...backup, file };
    } catch (e) {
      this.backup = backup;
      throw e;
    }
  }
  private mapping(track: SpotifyTrack): Mapping {
    return {
      spotifyTrackId: track.id,
      status: track.unavailable ? 'SOURCE_UNAVAILABLE' : 'NOT_FOUND',
      matchMethod: null,
      score: null,
      reasons: track.unavailable ? ['Source track unavailable or local'] : [],
      matcherVersion: MATCHER_VERSION,
      candidates: [],
      acceptedUrn: null,
      decision: 'pending',
      processedAt: null,
    };
  }
  startDiscovery() {
    this.assertIdle();
    if (!this.snapshot) throw new Error('Create Spotify snapshot first');
    const snapshotHash = hash(this.snapshot);
    if (this.discovery?.snapshotHash !== snapshotHash)
      this.discovery = {
        schemaVersion: 2,
        snapshotHash,
        status: 'idle',
        error: null,
        mappings: {},
      };
    this.stop = false;
    this.discoveryImmutable = false;
    this.job = {
      running: true,
      done: 0,
      total: Object.keys(this.snapshot.tracks).length,
      error: '',
    };
    void this.runDiscoverySafely();
  }
  private async runDiscoverySafely() {
    try {
      await this.discoveryLoop();
    } catch (e) {
      this.discovery!.status =
        e instanceof StorageError ? 'blocked' : this.stop ? 'paused' : 'blocked';
      this.discovery!.error =
        e instanceof StorageError
          ? e.message
          : this.stop
            ? null
            : e instanceof ApiError
              ? `API HTTP ${e.status}`
              : (e as Error).message;
      this.job.error = this.discovery!.error || '';
      // A failed checkpoint was already retried and its temp preserved. A second
      // failing save here used to become an unhandled rejection and kill Node.
      if (!(e instanceof StorageError)) {
        try {
          await this.saveDiscovery();
        } catch (storageError) {
          this.discovery!.status = 'blocked';
          this.discovery!.error =
            storageError instanceof Error ? storageError.message : 'Storage write failed';
          this.job.error = this.discovery!.error;
        }
      }
    } finally {
      this.job.running = false;
    }
  }
  pauseDiscovery() {
    this.stop = true;
  }
  private async discoveryLoop() {
    const snapshot = this.snapshot!,
      discovery = this.discovery!;
    discovery.status = 'running';
    await this.saveDiscovery();
    for (const track of Object.values(snapshot.tracks)) {
      if (this.stop) break;
      if (discovery.mappings[track.id]?.processedAt) {
        this.job.done++;
        continue;
      }
      const mapping = this.mapping(track);
      if (!track.unavailable) {
        const queries = [
          ...new Set([
            `${track.artists[0] || ''} ${track.title}`.trim(),
            `${normalize(track.artists[0] || '')} ${normalize(track.title)}`.trim(),
          ]),
        ].filter((q) => q.length >= 2);
        const found = new Map<string, Awaited<ReturnType<typeof soundCloudApi.track>>>();
        try {
          for (const q of queries)
            for (const candidate of await soundCloudApi.search(q, 50))
              found.set(candidate.urn, candidate);
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) {
            mapping.status = 'API_BLOCKED';
            mapping.reasons = ['SoundCloud search returned HTTP 403'];
            mapping.processedAt = new Date().toISOString();
            discovery.mappings[track.id] = mapping;
            this.job.done++;
            await this.saveDiscovery();
            continue;
          }
          throw e;
        }
        mapping.candidates = rank(track, [...found.values()]);
        const best = mapping.candidates[0];
        mapping.status = best?.category || 'NOT_FOUND';
        mapping.score = best?.score ?? null;
        mapping.reasons = best?.reasons || [];
        mapping.matchMethod =
          best?.category === 'VERIFIED'
            ? track.isrc &&
              best.track.isrc &&
              track.isrc.replace(/[^a-z0-9]/gi, '').toUpperCase() ===
                best.track.isrc.replace(/[^a-z0-9]/gi, '').toUpperCase()
              ? 'ISRC'
              : 'METADATA'
            : null;
        if (best?.category === 'VERIFIED') {
          const current = await soundCloudApi.track(best.track.urn);
          const confirmed = rank(track, [current])[0];
          if (confirmed.category === 'VERIFIED') {
            mapping.acceptedUrn = current.urn;
            mapping.candidates[0] = confirmed;
          } else {
            mapping.status = 'REVIEW';
            mapping.reasons.push('Current API metadata requires review');
          }
        }
      }
      mapping.processedAt = new Date().toISOString();
      discovery.mappings[track.id] = mapping;
      this.job.done++;
      await this.saveDiscovery();
    }
    discovery.status = this.stop ? 'paused' : 'completed';
    if (discovery.status === 'completed') discovery.error = null;
    await this.saveDiscovery();
    if (discovery.status === 'completed') this.discoveryImmutable = true;
  }
  async manualSearch(id: string, query: string) {
    this.assertIdle();
    const track = this.snapshot?.tracks[id],
      sourceMapping = this.activeDiscovery()?.mappings[id],
      mapping =
        sourceMapping && this.matchingMode === 'AGGRESSIVE_BEST_MATCH'
          ? structuredClone(sourceMapping)
          : sourceMapping;
    if (!track || !mapping) throw new Error('Unknown Spotify track');
    const found = await soundCloudApi.search(query, 50);
    const ranked = rank(track, found);
    mapping.candidates = [
      ...new Map([...mapping.candidates, ...ranked].map((c) => [c.track.urn, c])).values(),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    if (this.matchingMode === 'AGGRESSIVE_BEST_MATCH' && this.aggressive) {
      this.aggressive.overrides[id] = mapping;
      await saveJson(aggressiveFile, this.aggressive);
    } else {
      await this.saveDiscovery();
      this.aggressive = null;
    }
    return ranked;
  }
  async decide(id: string, action: 'accept' | 'reject' | 'skip', urn?: string) {
    this.assertIdle();
    const sourceMapping = this.activeDiscovery()?.mappings[id];
    const mapping =
      sourceMapping && this.matchingMode === 'AGGRESSIVE_BEST_MATCH'
        ? structuredClone(sourceMapping)
        : sourceMapping;
    if (!mapping) throw new Error('Unknown mapping');
    if (action === 'accept') {
      if (!urn || !mapping.candidates.some((c) => c.track.urn === urn))
        throw new Error('Candidate not found');
      const candidate = mapping.candidates.find((c) => c.track.urn === urn)!;
      const source = this.snapshot?.tracks[id];
      if (this.matchingMode === 'AGGRESSIVE_BEST_MATCH' && source) {
        const blocked = hardBlock(source, candidate.track);
        if (blocked) throw new Error(`Candidate blocked: ${blocked}`);
      }
      mapping.acceptedUrn = urn;
      mapping.decision = 'accepted';
      mapping.matchMethod = 'MANUAL';
      mapping.status = 'VERIFIED';
    } else {
      mapping.acceptedUrn = null;
      mapping.decision = action === 'reject' ? 'rejected' : 'skipped';
      mapping.status = 'REVIEW';
    }
    if (this.matchingMode === 'AGGRESSIVE_BEST_MATCH' && this.aggressive) {
      this.aggressive.overrides[id] = mapping;
      await saveJson(aggressiveFile, this.aggressive);
    } else {
      await this.saveDiscovery();
      this.aggressive = null;
    }
  }
  async prepare() {
    this.assertIdle();
    if (this.plan) throw new Error('An immutable migration plan already exists');
    const selectedDiscovery = this.activeDiscovery();
    if (
      !this.snapshot ||
      !selectedDiscovery ||
      selectedDiscovery.status !== 'completed' ||
      !this.backup?.complete
    )
      throw new Error('Complete snapshot, discovery and SoundCloud backup first');
    if (selectedDiscovery.snapshotHash !== hash(this.snapshot)) throw new Error('Snapshot changed');
    if (
      this.matchingMode === 'AGGRESSIVE_BEST_MATCH' &&
      this.aggressive?.sourceDiscoveryHash !== hash(this.discovery)
    )
      throw new Error('Strict discovery changed; rerun Auto-pick best matches');
    const me = await soundCloudApi.me();
    if (me.urn !== this.backup.accountUrn) throw new Error('SoundCloud account changed');
    const acceptedMappings: Record<string, string> = {};
    for (const [id, mapping] of Object.entries(selectedDiscovery.mappings))
      if (
        mapping.acceptedUrn &&
        (mapping.status === 'VERIFIED' ||
          mapping.status === 'AUTO_BEST_MATCH' ||
          mapping.decision === 'accepted')
      )
        acceptedMappings[id] = mapping.acceptedUrn;
    const playlists: PlaylistPlan[] = [];
    for (const p of this.snapshot.playlists) {
      if (p.status !== 'READY') continue;
      const urns = p.items
        .map((item) => item.spotifyTrackId && acceptedMappings[item.spotifyTrackId])
        .filter((v): v is string => !!v);
      (chunks(urns, 500).length ? chunks(urns, 500) : [[]]).forEach((part, i) =>
        playlists.push({
          key: `${p.id}:${i}`,
          sourceId: p.id,
          title: i ? `${p.name} — Part ${i + 1}` : p.name,
          urns: part,
          kind: 'SOURCE_PLAYLIST',
        }),
      );
    }
    const liked = this.snapshot.savedTracks.filter((id) => acceptedMappings[id]);
    chunks(
      liked.map((id) => acceptedMappings[id]),
      500,
    ).forEach((part, i) =>
      playlists.push({
        key: `likes:${i}`,
        sourceId: null,
        title: `Spotify Likes ${String(i + 1).padStart(3, '0')}`,
        urns: part,
        kind: 'LIKES_STAGING',
      }),
    );
    const plan: MigrationPlan = {
      schemaVersion: 2,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      snapshotHash: hash(this.snapshot),
      targetAccountUrn: me.urn,
      matcherVersion:
        this.matchingMode === 'AGGRESSIVE_BEST_MATCH'
          ? AGGRESSIVE_MATCHER_VERSION
          : MATCHER_VERSION,
      matchingMode: this.matchingMode,
      mappingSummary: {
        verified: Object.values(selectedDiscovery.mappings).filter(
          (m) => m.status === 'VERIFIED' && !!m.acceptedUrn,
        ).length,
        aggressive: Object.values(selectedDiscovery.mappings).filter(
          (m) => m.status === 'AUTO_BEST_MATCH' && !!m.acceptedUrn,
        ).length,
        skipped: Object.values(selectedDiscovery.mappings).filter((m) => !m.acceptedUrn).length,
      },
      acceptedMappings,
      existingLikes: this.backup.likes.map((t) => t.urn),
      plannedLikes: liked
        .map((id) => ({
          spotifyTrackId: id,
          urn: acceptedMappings[id],
          addedAt: this.snapshot!.tracks[id]?.spotifyAddedAt || null,
        }))
        .sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || '')),
      playlists,
      unsupported: this.snapshot.playlists.filter((p) => p.status !== 'READY').map((p) => p.id),
      notFound: Object.values(selectedDiscovery.mappings)
        .filter((m) => !acceptedMappings[m.spotifyTrackId])
        .map((m) => m.spotifyTrackId),
      backupFile: this.backupFile!,
    };
    const path = `data/migration-plan-${plan.id}.json`;
    await saveJson(path, plan);
    await saveJson(pointerFile, { file: path });
    this.plan = plan;
    this.journal = {
      schemaVersion: 2,
      planId: plan.id,
      accountUrn: me.urn,
      playlists: {},
      likes: {},
      status: 'idle',
      likeOrder: 'unknown',
    };
    await this.saveJournal();
    return plan;
  }
  private async assertWriteReady() {
    if (!this.plan || !this.journal || !this.backup?.complete || !this.snapshot)
      throw new Error('Plan and complete backup required');
    if (hash(this.snapshot) !== this.plan.snapshotHash) throw new Error('Spotify snapshot changed');
    const me = await soundCloudApi.me();
    if (me.urn !== this.plan.targetAccountUrn) throw new Error('SoundCloud account changed');
  }
  private async verifyPlaylist(item: PlaylistPlan, urn: string) {
    const prior = this.journal!.playlists[item.key];
    const expected = prior?.duplicateFallbackAccepted
      ? { ...item, urns: [...new Set(item.urns)] }
      : item;
    const { tracks, pagesRead } = await soundCloudApi.playlistTracksDetailed(urn);
    const report = mismatchReport(expected, urn, tracks, pagesRead);
    if (!report) return;
    const status = mismatchStatus(expected, tracks);
    try {
      const detail = await soundCloudApi.playlistWithTracks(urn);
      if (Array.isArray(detail?.tracks)) {
        const detailUrns = detail.tracks.map((t: any) =>
          typeof t?.urn === 'string' ? t.urn : t?.id != null ? `soundcloud:tracks:${t.id}` : null,
        );
        report.showTracksCount = detailUrns.length;
        report.showTracksMatchesReadBack =
          JSON.stringify(detailUrns) === JSON.stringify(tracks.map((t) => t.urn));
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    for (const missing of [...new Set(report.missingUrns)]) {
      try {
        const track = await soundCloudApi.track(missing);
        report.missingTrackDetails.push({
          urn: missing,
          access: track.access || null,
          reason: tracks.some((t) => t.urn === missing) ? 'Duplicate occurrence omitted' : null,
        });
      } catch (e) {
        report.missingTrackDetails.push({
          urn: missing,
          access: null,
          reason: e instanceof ApiError ? `GET track HTTP ${e.status}` : 'Track GET failed',
        });
      }
    }
    if (prior) {
      prior.verified = false;
      prior.verificationStatus = status;
      prior.mismatch = report;
      await this.saveJournal();
    }
    throw new PlaylistMismatchError(status, report);
  }
  async diagnoseFirstUnverifiedPlaylist() {
    this.assertIdle();
    if (!this.plan || !this.journal) throw new Error('Migration plan missing');
    const item = this.plan.playlists
      .filter(isSourcePlaylist)
      .find((p) => !this.journal!.playlists[p.key]?.verified);
    if (!item) return { status: 'ALL_VERIFIED' };
    const urn = this.journal.playlists[item.key]?.urn;
    if (!urn) return { status: 'NOT_CREATED', playlistName: item.title, playlistKey: item.key };
    try {
      await this.verifyPlaylist(item, urn);
      return { status: 'VERIFIED', playlistName: item.title, playlistUrn: urn };
    } catch (e) {
      if (e instanceof PlaylistMismatchError) return { status: e.status, report: e.report };
      throw e;
    }
  }
  async executePlaylists(confirmation: string, maxNew = Infinity) {
    this.assertIdle();
    await this.assertWriteReady();
    if (confirmation !== `PLAYLISTS ${this.plan!.id}`)
      throw new Error('Explicit playlist confirmation required');
    this.job.running = true;
    this.stop = false;
    let createdCount = 0;
    try {
      const sourcePlaylists = this.plan!.playlists.filter(isSourcePlaylist);
      // Read-only preflight: never start a new POST if a previously verified
      // playlist has disappeared or changed since the last run.
      for (const item of sourcePlaylists) {
        const prior = this.journal!.playlists[item.key];
        if (prior?.verified) await this.verifyPlaylist(item, prior.urn);
      }
      for (const item of sourcePlaylists) {
        if (this.stop) break;
        if (createdCount >= maxNew) break;
        if (this.journal!.unknownPlaylistKey && this.journal!.unknownPlaylistKey !== item.key)
          throw new UnknownOutcome();
        const prior = this.journal!.playlists[item.key];
        if (prior?.verified) continue;
        if (prior?.urn) {
          try {
            await this.verifyPlaylist(item, prior.urn);
          } catch (e) {
            if (
              !(e instanceof PlaylistMismatchError) ||
              e.status === 'UNSUPPORTED_DUPLICATE_OCCURRENCES' ||
              e.report.missingTrackDetails.some(
                (track) => track.access === 'blocked' || track.access === 'preview',
              )
            )
              throw e;
            // Resume reuses the saved URN. A single PUT repairs ordinary
            // count/order drift; duplicate loss requires separate approval.
            await soundCloudApi.updatePlaylist(prior.urn, item.title, item.urns);
            await this.verifyPlaylist(item, prior.urn);
          }
          prior.verified = true;
          prior.verificationStatus = prior.duplicateFallbackAccepted
            ? 'UNSUPPORTED_DUPLICATE_OCCURRENCES_ACCEPTED'
            : 'VERIFIED';
          prior.mismatch = undefined;
          await this.saveJournal();
          continue;
        }
        let created: any;
        try {
          if (this.journal!.unknownPlaylistKey) throw new UnknownOutcome();
          this.journal!.unknownPlaylistKey = item.key;
          this.journal!.status = 'UNKNOWN';
          await this.saveJournal();
          created = await soundCloudApi.createPlaylist(item.title, item.urns);
        } catch (e) {
          if (e instanceof ApiError) {
            await saveJson(
              `data/audit/playlist-acceptance-error-${this.plan!.id}-${stamp()}.json`,
              {
                schemaVersion: 2,
                planId: this.plan!.id,
                playlistKey: item.key,
                status: e.status,
                response: e.safeBody,
              },
            );
          }
          if (e instanceof UnknownOutcome) {
            this.journal!.unknownPlaylistKey = item.key;
            this.journal!.status = 'UNKNOWN';
            await this.saveJournal();
            const sameTitle = (await soundCloudApi.playlists()).filter(
              (p) => p.title === item.title && typeof p.urn === 'string',
            );
            const matches: string[] = [];
            for (const p of sameTitle) {
              const tracks = await soundCloudApi.playlistTracks(p.urn);
              if (
                tracks.length === item.urns.length &&
                tracks.every((t, i) => t.urn === item.urns[i])
              )
                matches.push(p.urn);
            }
            if (matches.length === 1) {
              created = { urn: matches[0] };
              this.journal!.unknownPlaylistKey = undefined;
              await this.saveJournal();
            } else throw e;
          } else throw e;
        }
        if (typeof created?.urn !== 'string') throw new Error('Playlist response missing URN');
        this.journal!.playlists[item.key] = { urn: created.urn, verified: false };
        this.journal!.unknownPlaylistKey = undefined;
        await this.saveJournal();
        await this.verifyPlaylist(item, created.urn);
        this.journal!.playlists[item.key].verified = true;
        this.journal!.playlists[item.key].verificationStatus = 'VERIFIED';
        await this.saveJournal();
        createdCount++;
      }
      this.journal!.status = this.stop ? 'paused' : 'idle';
      await this.saveJournal();
    } catch (e) {
      this.journal!.status = e instanceof UnknownOutcome ? 'UNKNOWN' : 'paused';
      await this.saveJournal();
      throw e;
    } finally {
      this.job.running = false;
    }
    return this.journal;
  }
  async acceptDuplicateFallback(key: string, confirmation: string) {
    if (confirmation !== `ACCEPT DUPLICATE LOSS ${this.plan?.id} ${key}`)
      throw new Error('Explicit duplicate-loss confirmation required');
    return this.applyDuplicateFallback(key);
  }
  async autoAcceptDuplicateFallback(key: string) {
    return this.applyDuplicateFallback(key);
  }
  private async applyDuplicateFallback(key: string) {
    this.assertIdle();
    await this.assertWriteReady();
    const item = this.plan!.playlists.find((p) => p.key === key);
    const prior = this.journal!.playlists[key];
    if (!item || !prior?.urn || prior.verificationStatus !== 'UNSUPPORTED_DUPLICATE_OCCURRENCES')
      throw new Error('No diagnosed duplicate-occurrence mismatch for this playlist');
    const readback = await soundCloudApi.playlistTracksDetailed(prior.urn);
    if (
      !isStableUniqueReadback(
        item.urns,
        readback.tracks.map((track) => track.urn),
      )
    )
      throw new Error('Playlist changed; duplicate fallback no longer matches read-back');
    const duplicateDetails = duplicateOccurrences(item.urns).map(({ urn, positions }) => ({
      duplicateUrn: urn,
      keptPosition: positions[0],
      lostPositions: positions.slice(1),
    }));
    const lostPositions = duplicateDetails.flatMap(({ duplicateUrn, lostPositions: positions }) =>
      positions.map((position) => ({ urn: duplicateUrn, position })),
    );
    await saveJson(
      `data/audit/duplicate-fallback-${this.plan!.id}-${stamp()}-${randomUUID()}.json`,
      {
        schemaVersion: 2,
        planId: this.plan!.id,
        playlistKey: key,
        playlistName: item.title,
        playlistUrn: prior.urn,
        plannedCount: item.urns.length,
        actualCount: readback.tracks.length,
        duplicates: duplicateDetails,
        lostPositions,
        acceptedAt: new Date().toISOString(),
      },
    );
    prior.duplicateFallbackAccepted = true;
    prior.verificationStatus = 'UNSUPPORTED_DUPLICATE_OCCURRENCES_ACCEPTED';
    prior.verified = true;
    await this.saveJournal();
    return { key, lostPositions };
  }
  pause() {
    this.stop = true;
    this.guidedStop = true;
  }
  async startGuidedTransfer() {
    if (this.guided.running || this.job.running) throw new Error('Another job is running');
    this.guided = { running: true, phase: 'compatibility', error: '', retryAt: null };
    try {
      await this.assertWriteReady();
      if (this.journal!.status === 'completed') {
        this.guided = { running: false, phase: 'done', error: '', retryAt: null };
        return { ok: true, state: 'completed', previousStatus: 'completed', retryAt: null };
      }
      const previousStatus = this.journal!.status;
      this.resumePreviousStatus = previousStatus;
      const retryAt =
        previousStatus === 'RATE_LIMITED' ? this.journal!.rateLimit?.retryAt || null : null;
      const remaining = retryAt ? Date.parse(retryAt) - Date.now() : 0;
      if (Number.isFinite(remaining) && remaining > 0) {
        this.guided = { running: false, phase: 'paused', error: '', retryAt };
        return {
          ok: false,
          state: 'RATE_LIMITED',
          previousStatus,
          retryAt,
          retryAfterSeconds: Math.ceil(remaining / 1000),
        };
      }
      if (previousStatus === 'RATE_LIMITED') {
        this.journal!.status = 'RESUMING';
        try {
          await this.saveJournal();
        } catch (error) {
          this.journal!.status = previousStatus;
          throw error;
        }
      }
      this.guided.phase = 'reconciling';
      this.guidedStop = false;
      void this.runGuidedTransfer();
      return { ok: true, state: 'RESUMING', previousStatus, retryAt };
    } catch (error) {
      this.guided.running = false;
      throw error;
    }
  }
  private async runGuidedTransfer() {
    try {
      const plan = this.plan!,
        journal = this.journal!;
      const sourcePlaylists = plan.playlists.filter(isSourcePlaylist);
      for (let i = 0; i < sourcePlaylists.length && !this.guidedStop; i++) {
        const item = sourcePlaylists.find((p) => !journal.playlists[p.key]?.verified);
        if (!item) break;
        this.guided.phase =
          i === 0 && !Object.keys(journal.playlists).length ? 'compatibility' : 'playlists';
        try {
          await this.executePlaylists(`PLAYLISTS ${plan.id}`, 1);
        } catch (error) {
          if (
            !(error instanceof PlaylistMismatchError) ||
            error.status !== 'UNSUPPORTED_DUPLICATE_OCCURRENCES' ||
            journal.playlists[item.key]?.verificationStatus !== 'UNSUPPORTED_DUPLICATE_OCCURRENCES'
          )
            throw error;
          await this.autoAcceptDuplicateFallback(item.key);
        }
      }
      if (this.guidedStop) return;
      for (const staging of plan.playlists.filter(isLikesStaging)) {
        const record = journal.playlists[staging.key];
        if (record?.verified) record.stagingStatus = 'VERIFIED';
        else if (record?.urn) record.stagingStatus = 'PARTIAL';
        else {
          journal.playlists[staging.key] = {
            urn: '',
            verified: false,
            stagingStatus: 'SKIPPED',
          };
        }
      }
      await this.saveJournal();
      if (!sourcePlaylists.every((p) => journal.playlists[p.key]?.verified))
        throw new Error('A playlist needs attention before Likes can continue');
      this.guided.phase = 'reconciling';
      if (journal.likeOrder === 'unknown') {
        const present = new Set((await soundCloudApi.likes()).map((track) => track.urn));
        const candidates = [...new Set(plan.plannedLikes.map((item) => item.urn))]
          .filter((urn) => !present.has(urn))
          .slice(0, 3);
        if (candidates.length >= 2) await this.likeOrderTest(candidates, 'TEST LIKE ORDER');
        else {
          // With at most one Like to add, order cannot change the result.
          journal.likeOrder = 'newest-first';
          await this.saveJournal();
        }
      }
      if (!this.guidedStop) await this.executeLikes(`LIKES ${plan.id}`);
      this.guided.phase = journal.status === 'completed' ? 'done' : 'paused';
    } catch (error) {
      this.guided.phase = 'paused';
      this.guided.error = error instanceof Error ? error.message : 'Transfer failed';
      if (
        this.journal &&
        this.journal.status !== 'UNKNOWN' &&
        this.journal.status !== 'RATE_LIMITED' &&
        this.journal.status !== 'PAUSED_STORAGE_ERROR'
      ) {
        this.journal.status = 'paused';
        try {
          await this.saveJournal();
        } catch (storageError) {
          this.guided.error =
            storageError instanceof Error ? storageError.message : 'Storage write failed';
        }
      }
    } finally {
      this.guided.running = false;
      if (this.guidedStop) this.guided.phase = 'paused';
    }
  }
  async likeOrderTest(urns: string[], confirmation: string) {
    this.assertIdle();
    await this.assertWriteReady();
    if (
      urns.length < 2 ||
      urns.length > 3 ||
      new Set(urns).size !== urns.length ||
      confirmation !== 'TEST LIKE ORDER'
    )
      throw new Error('Choose 2–3 unique tracks and confirm');
    if (
      !this.plan!.playlists.filter(isSourcePlaylist).every(
        (p) => this.journal!.playlists[p.key]?.verified,
      )
    )
      throw new Error('Transfer playlists first');
    const allowed = new Set(this.plan!.plannedLikes.map((x) => x.urn));
    if (urns.some((urn) => !allowed.has(urn)))
      throw new Error('Only accepted mapped tracks can be tested');
    const before = await soundCloudApi.likes();
    const existing = new Set(before.map((t) => t.urn));
    if (urns.some((urn) => existing.has(urn))) throw new Error('Choose tracks not already liked');
    for (const urn of urns) {
      const startedAt = new Date().toISOString();
      let outcome = 'POST_OK';
      try {
        await soundCloudApi.like(urn);
      } catch (e) {
        if (e instanceof UnknownOutcome) outcome = 'UNKNOWN_POST';
        else throw e;
      }
      const current = new Set((await soundCloudApi.likes()).map((t) => t.urn));
      this.journal!.likes[urn] = {
        spotifyTrackId: this.plan!.plannedLikes.find((x) => x.urn === urn)?.spotifyTrackId || null,
        soundcloudUrn: urn,
        startedAt,
        finishedAt: new Date().toISOString(),
        stateBefore: 'ABSENT',
        requestOutcome: outcome,
        stateAfter: current.has(urn) ? 'PRESENT' : 'ABSENT',
      };
      await this.saveJournal();
      if (!current.has(urn)) {
        this.journal!.status = 'UNKNOWN';
        await this.saveJournal();
        throw new Error('Like test read-back failed');
      }
    }
    const after = await soundCloudApi.likes();
    const positions = urns.map((urn) => after.findIndex((t) => t.urn === urn));
    const order = positions.every((p, i) => i === 0 || p < positions[i - 1])
      ? 'newest-first'
      : positions.every((p, i) => i === 0 || p > positions[i - 1])
        ? 'oldest-first'
        : 'unknown';
    if (order === 'unknown') throw new Error('Like order ambiguous; bulk Likes disabled');
    this.journal!.likeOrder = order;
    await this.saveJournal();
    return { order, positions };
  }
  async executeLikes(confirmation: string) {
    this.assertIdle();
    await this.assertWriteReady();
    if (confirmation !== `LIKES ${this.plan!.id}`)
      throw new Error('Explicit Likes confirmation required');
    if (
      !this.plan!.playlists.filter(isSourcePlaylist).every(
        (p) => this.journal!.playlists[p.key]?.verified,
      )
    )
      throw new Error('Playlists not verified');
    if (this.journal!.likeOrder === 'unknown')
      throw new Error('Like order acceptance test required');
    this.job.running = true;
    this.stop = false;
    try {
      const queue =
        this.journal!.likeOrder === 'newest-first'
          ? this.plan!.plannedLikes
          : [...this.plan!.plannedLikes].reverse();
      const previousStatus = this.resumePreviousStatus || this.journal!.status;
      const retryAt = this.journal!.rateLimit?.retryAt || null;
      const present = new Set((await soundCloudApi.likes()).map((track) => track.urn));
      const now = new Date().toISOString();
      for (const item of queue) {
        if (!present.has(item.urn) || this.journal!.likes[item.urn]?.stateAfter === 'PRESENT')
          continue;
        this.journal!.likes[item.urn] = {
          spotifyTrackId: item.spotifyTrackId,
          soundcloudUrn: item.urn,
          startedAt: now,
          finishedAt: now,
          stateBefore: 'PRESENT',
          requestOutcome: 'SUCCESS_ALREADY_PRESENT',
          stateAfter: 'PRESENT',
        };
      }
      const nextMissing = queue.find(
        (item) => this.journal!.likes[item.urn]?.stateAfter !== 'PRESENT' && !present.has(item.urn),
      );
      console.info('[likes-resume]', {
        previousStatus,
        retryAt,
        retryExpired: !retryAt || Date.parse(retryAt) <= Date.now(),
        planned: queue.length,
        checkpointConfirmed: Object.values(this.journal!.likes).filter(
          (op) => op.stateAfter === 'PRESENT',
        ).length,
        alreadyPresentAfterReadback: queue.filter((item) => present.has(item.urn)).length,
        nextMissingUrnPresent: nextMissing ? present.has(nextMissing.urn) : false,
        attemptingPost: !!nextMissing,
      });
      this.journal!.rateLimit = null;
      this.journal!.status = 'running';
      await this.saveJournal();
      this.guided.phase = 'likes';
      for (const item of queue) {
        if (this.stop) break;
        if (this.journal!.likes[item.urn]?.stateAfter === 'PRESENT') continue;
        const startedAt = new Date().toISOString();
        const before = new Set((await soundCloudApi.likes()).map((t) => t.urn));
        let outcome = 'SKIP_ALREADY_PRESENT';
        if (!before.has(item.urn)) {
          try {
            await soundCloudApi.like(item.urn);
            console.info('[likes-resume]', {
              statusCode: null,
              rateLimited: false,
              retryAfter: null,
            });
            outcome = 'POST_OK';
          } catch (e) {
            if (e instanceof ApiError && e.status === 429) {
              const wait =
                e.retryAfter &&
                (/^\d+(?:\.\d+)?$/.test(e.retryAfter)
                  ? Number(e.retryAfter) * 1000
                  : Date.parse(e.retryAfter) - Date.now());
              this.guided.retryAt =
                wait && Number.isFinite(wait) && wait > 0
                  ? new Date(Date.now() + wait).toISOString()
                  : null;
              const retryAfterSeconds =
                wait && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait / 1000) : null;
              this.journal!.rateLimit = {
                detectedAt: new Date().toISOString(),
                retryAfterSeconds,
                retryAt: this.guided.retryAt,
                upstreamStatus: 429,
              };
              console.info('[likes-resume]', {
                statusCode: 429,
                rateLimited: true,
                retryAfter: retryAfterSeconds,
              });
              this.journal!.status = 'RATE_LIMITED';
              await this.saveJournal();
              break;
            }
            if (e instanceof ApiError)
              console.info('[likes-resume]', {
                statusCode: e.status,
                rateLimited: false,
                retryAfter: null,
              });
            if (!(e instanceof UnknownOutcome)) throw e;
            outcome = 'UNKNOWN_POST';
          }
          this.journal!.likes[item.urn] = {
            spotifyTrackId: item.spotifyTrackId,
            soundcloudUrn: item.urn,
            startedAt,
            finishedAt: new Date().toISOString(),
            stateBefore: 'ABSENT',
            requestOutcome: outcome,
            stateAfter: 'UNKNOWN',
          };
          await this.saveJournal();
        }
        const after = new Set((await soundCloudApi.likes()).map((t) => t.urn));
        const op: Operation = {
          spotifyTrackId: item.spotifyTrackId,
          soundcloudUrn: item.urn,
          startedAt,
          finishedAt: new Date().toISOString(),
          stateBefore: before.has(item.urn) ? 'PRESENT' : 'ABSENT',
          requestOutcome: outcome,
          stateAfter: after.has(item.urn) ? 'PRESENT' : 'ABSENT',
        };
        this.journal!.likes[item.urn] = op;
        await this.saveJournal();
        if (!after.has(item.urn)) {
          this.journal!.status = 'UNKNOWN';
          await this.saveJournal();
          break;
        }
      }
      if (this.journal!.status === 'running') {
        this.journal!.status = this.stop ? 'paused' : 'completed';
        await this.saveJournal();
      }
    } catch (error) {
      if (error instanceof StorageError) {
        this.journal!.status = 'PAUSED_STORAGE_ERROR';
        try {
          await this.saveJournal();
        } catch {
          // The original storage error is the actionable failure; keep the server alive.
        }
      }
      throw error;
    } finally {
      this.job.running = false;
    }
    return this.journal;
  }
  async audit() {
    await this.assertWriteReady();
    const likes = new Set((await soundCloudApi.likes()).map((t) => t.urn));
    const targetLikes = new Set(this.plan!.plannedLikes.map((x) => x.urn));
    const playlists = [];
    for (const item of this.plan!.playlists) {
      const created = this.journal!.playlists[item.key];
      if (!created) {
        playlists.push({ key: item.key, status: 'MISSING' });
        continue;
      }
      const tracks = await soundCloudApi.playlistTracks(created.urn);
      const actual = tracks.map((t) => t.urn);
      playlists.push({
        key: item.key,
        urn: created.urn,
        missingTracks: item.urns.filter((urn) => !actual.includes(urn)),
        status:
          tracks.length === item.urns.length && tracks.every((t, i) => t.urn === item.urns[i])
            ? 'VERIFIED'
            : 'ORDER_MISMATCH',
      });
    }
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      planId: this.plan!.id,
      uniqueSpotifyTracks: Object.keys(this.snapshot!.tracks).length,
      mappings: Object.values(this.activeDiscovery()?.mappings || {}).reduce(
        (a, m) => {
          a[m.status] = (a[m.status] || 0) + 1;
          return a;
        },
        {} as Record<string, number>,
      ),
      verifiedByIsrc: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.status === 'VERIFIED' && m.matchMethod === 'ISRC',
      ).length,
      verifiedByMetadata: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.status === 'VERIFIED' && m.matchMethod === 'METADATA',
      ).length,
      manualApprovals: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.decision === 'accepted',
      ).length,
      reviewRemaining: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.status === 'REVIEW',
      ).length,
      notFound: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.status === 'NOT_FOUND',
      ).length,
      apiBlocked: Object.values(this.activeDiscovery()?.mappings || {}).filter(
        (m) => m.status === 'API_BLOCKED',
      ).length,
      likes: {
        planned: this.plan!.plannedLikes.length,
        alreadyPresent: this.plan!.plannedLikes.filter((x) =>
          this.plan!.existingLikes.includes(x.urn),
        ).length,
        added: Object.values(this.journal!.likes).filter(
          (x) => x.stateBefore === 'ABSENT' && x.stateAfter === 'PRESENT',
        ).length,
        verified: this.plan!.plannedLikes.filter((x) => likes.has(x.urn)).length,
        missing: this.plan!.plannedLikes.filter((x) => !likes.has(x.urn)).map((x) => x.urn),
        unknown: Object.values(this.journal!.likes)
          .filter((x) => x.stateAfter === 'UNKNOWN')
          .map((x) => x.soundcloudUrn),
      },
      playlistSummary: {
        planned: this.plan!.playlists.length,
        created: Object.keys(this.journal!.playlists).length,
        verified: playlists.filter((p) => p.status === 'VERIFIED').length,
        orderMismatch: playlists.filter((p) => p.status === 'ORDER_MISMATCH').length,
        missingTracks: playlists.reduce(
          (n, p) => n + (Array.isArray(p.missingTracks) ? p.missingTracks.length : 0),
          0,
        ),
      },
      playlists,
      likeComparison: {
        alreadyCorrect: [...targetLikes].filter((urn) => likes.has(urn)),
        missing: [...targetLikes].filter((urn) => !likes.has(urn)),
        extraneous: [...likes].filter((urn) => !targetLikes.has(urn)),
      },
    };
    await saveJson(`data/audit/${this.plan!.id}-${stamp()}.json`, report);
    return report;
  }
}
