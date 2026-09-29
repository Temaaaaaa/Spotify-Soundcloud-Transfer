import type {
  AggressiveDiscovery,
  Candidate,
  Discovery,
  Mapping,
  SoundCloudTrack,
  SpotifyTrack,
} from '../shared/types.js';
import { match, normalize, validIsrc, versions } from './matcher.js';

export const AGGRESSIVE_MATCHER_VERSION = '3.0.0';
const hardVersion = new Set([
  'remix',
  'sped up',
  'slowed',
  'reverb',
  'nightcore',
  'cover',
  'live',
  'instrumental',
  'karaoke',
  'mashup',
  'bootleg',
]);

export function hardBlock(source: SpotifyTrack, target: SoundCloudTrack): string | null {
  if (source.unavailable) return 'Spotify track unavailable';
  const si = validIsrc(source.isrc);
  const ti = validIsrc(target.isrc);
  if (si && ti && si !== ti) return 'Conflicting valid ISRC';
  const originalVersions = new Set(versions(source.title));
  const extra = versions(target.title).filter(
    (v) => hardVersion.has(v) && !originalVersions.has(v),
  );
  if (extra.length) return `Different version: ${extra.join(', ')}`;
  if (source.duration_ms != null && target.duration != null) {
    const delta = Math.abs(source.duration_ms - target.duration);
    if (delta > Math.max(30000, source.duration_ms * 0.2)) return 'Extreme duration mismatch';
  }
  return null;
}

function compare(source: SpotifyTrack, a: Candidate, b: Candidate): number {
  const sameIsrc = (c: Candidate) => {
    const isrc = validIsrc(source.isrc);
    return !!isrc && isrc === validIsrc(c.track.isrc) ? 1 : 0;
  };
  const delta = (c: Candidate) =>
    source.duration_ms == null || c.track.duration == null
      ? Infinity
      : Math.abs(source.duration_ms - c.track.duration);
  return (
    b.score - a.score ||
    sameIsrc(b) - sameIsrc(a) ||
    delta(a) - delta(b) ||
    b.components.title - a.components.title ||
    b.components.artist - a.components.artist ||
    a.track.urn.localeCompare(b.track.urn)
  );
}

export function selectAggressive(
  source: SpotifyTrack,
  previous: Mapping,
  tracks: SoundCloudTrack[],
): Mapping {
  const unique = [...new Map(tracks.map((track) => [track.urn, track])).values()];
  const eligible = unique
    .filter((track) => !hardBlock(source, track))
    .map((track) => match(source, track));
  eligible.sort((a, b) => compare(source, a, b));
  const best = eligible[0];
  const candidates = eligible.slice(0, 50);
  if (!best) {
    const blocked = unique.map((track) => ({ track, reason: hardBlock(source, track)! }));
    return {
      ...previous,
      status: unique.length ? 'HARD_REJECTED_ALL' : 'NOT_FOUND',
      candidates: unique.slice(0, 5).map((track) => match(source, track)),
      acceptedUrn: null,
      selectedSoundCloudUrn: null,
      score: null,
      matchMethod: null,
      aggressive: true,
      matcherVersion: AGGRESSIVE_MATCHER_VERSION,
      reasons: [
        unique.length ? 'All candidates failed hard rules' : 'SKIPPED_NO_CANDIDATE',
        ...[...new Set(blocked.map((item) => item.reason))],
      ],
      processedAt: new Date().toISOString(),
    };
  }
  return {
    ...previous,
    status: 'AUTO_BEST_MATCH',
    candidates,
    acceptedUrn: best.track.urn,
    selectedSoundCloudUrn: best.track.urn,
    score: best.score,
    reasons: ['Best eligible candidate selected automatically', ...best.reasons],
    matchMethod: 'AGGRESSIVE_BEST_MATCH',
    aggressive: true,
    matcherVersion: AGGRESSIVE_MATCHER_VERSION,
    decision: 'accepted',
    processedAt: new Date().toISOString(),
  };
}

export function expandedQueries(track: SpotifyTrack): string[] {
  const artist = track.artists[0] || '';
  const title = track.title;
  const noFeat = title.replace(/\s*(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+.+$/i, '').trim();
  const versionSuffix =
    '(?:remix|mix|radio edit|edit|remaster(?:ed)?|acoustic|extended|version|edition|live|instrumental|karaoke|sped up|speed up|slowed|nightcore|cover|mashup|bootleg)';
  const noVersion = title
    .replace(
      new RegExp(
        `\\s*(?:\\([^)]*${versionSuffix}[^)]*\\)|\\[[^\\]]*${versionSuffix}[^\\]]*\\]|[-–—]\\s*[^-–—]*${versionSuffix}[^-–—]*)\\s*$`,
        'iu',
      ),
      '',
    )
    .trim();
  const raw = [
    `${artist} ${title}`.trim(),
    title,
    `${normalize(artist)} ${normalize(title)}`.trim(),
    noFeat,
    noVersion,
  ];
  return [...new Set(raw.filter((q) => q.length >= 2))];
}

export function mergedDiscovery(strict: Discovery, aggressive: AggressiveDiscovery): Discovery {
  return {
    ...strict,
    status: aggressive.status,
    error: aggressive.error,
    mappings: { ...strict.mappings, ...aggressive.overrides },
  };
}

export function aggressiveSummary(strict: Discovery, aggressive: AggressiveDiscovery | null) {
  const mappings = aggressive ? mergedDiscovery(strict, aggressive).mappings : strict.mappings;
  const values = Object.values(mappings);
  return {
    verified: values.filter((m) => m.status === 'VERIFIED').length,
    aggressive: values.filter((m) => m.status === 'AUTO_BEST_MATCH').length,
    reviewAuto: Object.entries(strict.mappings).filter(
      ([id, m]) => m.status === 'REVIEW' && aggressive?.overrides[id]?.status === 'AUTO_BEST_MATCH',
    ).length,
    notFoundAuto: Object.entries(strict.mappings).filter(
      ([id, m]) =>
        m.status === 'NOT_FOUND' && aggressive?.overrides[id]?.status === 'AUTO_BEST_MATCH',
    ).length,
    notFoundNoCandidate: Object.entries(strict.mappings).filter(
      ([id, m]) => m.status === 'NOT_FOUND' && aggressive?.overrides[id]?.status === 'NOT_FOUND',
    ).length,
    notFound: values.filter((m) => m.status === 'NOT_FOUND').length,
    hardRejectedAll: values.filter((m) => m.status === 'HARD_REJECTED_ALL').length,
    skipped: values.filter((m) => !m.acceptedUrn).length,
  };
}
