import type {
  PlaylistMismatchReport,
  PlaylistPlan,
  PlaylistVerificationStatus,
  SoundCloudTrack,
} from '../shared/types.js';

export function duplicateOccurrences(urns: string[]) {
  const positions = new Map<string, number[]>();
  urns.forEach((urn, index) => positions.set(urn, [...(positions.get(urn) || []), index]));
  return [...positions]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([urn, indexes]) => ({ urn, positions: indexes }));
}

/** The only read-back shape that permits the duplicate-occurrence fallback. */
export function stableUnique(urns: string[]) {
  return [...new Set(urns)];
}

export function isStableUniqueReadback(planned: string[], actual: string[]) {
  const unique = stableUnique(planned);
  return (
    planned.length !== actual.length &&
    actual.length === unique.length &&
    actual.every((urn, index) => urn === unique[index])
  );
}

function multisetDifference(left: string[], right: string[]): string[] {
  const counts = new Map<string, number>();
  for (const urn of right) counts.set(urn, (counts.get(urn) || 0) + 1);
  return left.filter((urn) => {
    const remaining = counts.get(urn) || 0;
    if (!remaining) return true;
    counts.set(urn, remaining - 1);
    return false;
  });
}

export function mismatchReport(
  item: PlaylistPlan,
  playlistUrn: string,
  tracks: SoundCloudTrack[],
  pagesRead: number,
): PlaylistMismatchReport | null {
  const expected = item.urns;
  const actual = tracks.map((track) => track.urn);
  if (expected.length === actual.length && expected.every((urn, i) => urn === actual[i]))
    return null;
  const first = expected.findIndex((urn, i) => urn !== actual[i]);
  const firstMismatchIndex = first < 0 ? Math.min(expected.length, actual.length) : first;
  const accessCounts: Record<string, number> = {};
  for (const track of tracks) {
    const access = track.access || 'unknown';
    accessCounts[access] = (accessCounts[access] || 0) + 1;
  }
  return {
    playlistName: item.title,
    playlistUrn,
    plannedCount: expected.length,
    actualCount: actual.length,
    pagesRead,
    duplicatePlannedUrns: duplicateOccurrences(expected),
    firstMismatchIndex,
    expectedUrn: expected[firstMismatchIndex] || null,
    actualUrn: actual[firstMismatchIndex] || null,
    missingUrns: multisetDifference(expected, actual),
    unexpectedUrns: multisetDifference(actual, expected),
    accessCounts,
    missingTrackDetails: [],
    showTracksCount: null,
    showTracksMatchesReadBack: null,
  };
}

export function mismatchStatus(
  item: PlaylistPlan,
  actual: SoundCloudTrack[],
): PlaylistVerificationStatus {
  const urns = actual.map((track) => track.urn);
  if (isStableUniqueReadback(item.urns, urns)) return 'UNSUPPORTED_DUPLICATE_OCCURRENCES';
  return item.urns.length === urns.length ? 'ORDER_MISMATCH' : 'COUNT_MISMATCH';
}

export class PlaylistMismatchError extends Error {
  constructor(
    readonly status: PlaylistVerificationStatus,
    readonly report: PlaylistMismatchReport,
  ) {
    super(
      `Playlist ${status}: ${report.playlistName}; planned ${report.plannedCount}, actual ${report.actualCount}, first mismatch ${report.firstMismatchIndex}`,
    );
    this.name = 'PlaylistMismatchError';
  }
}
