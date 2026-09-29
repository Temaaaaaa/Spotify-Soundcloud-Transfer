// Read-only diagnostic for the first unverified playlist. Never prints OAuth tokens.
// Run: node --import tsx scripts/diagnose-playlist.ts
import { readFile } from 'node:fs/promises';

const api = 'https://api.soundcloud.com';
const pointer = JSON.parse(await readFile('data/current-plan.json', 'utf8'));
const plan = JSON.parse(await readFile(pointer.file, 'utf8'));
const journal = JSON.parse(await readFile(`data/operations/${plan.id}.json`, 'utf8'));
const snapshot = JSON.parse(await readFile('data/spotify-snapshot.json', 'utf8'));
const token = JSON.parse(await readFile('data/tokens/soundcloud.json', 'utf8'));
if (token.blocked || token.expires_at < Date.now() + 60000)
  throw new Error('SoundCloud token unavailable or expiring; diagnostic made no requests');
const index = plan.playlists.findIndex((item: any) => !journal.playlists[item.key]?.verified);
if (index < 0) throw new Error('No unverified playlist in journal');
const item = plan.playlists[index];
const playlistUrn = journal.playlists[item.key]?.urn;
if (typeof playlistUrn !== 'string' || !/^soundcloud:playlists:\d+$/.test(playlistUrn))
  throw new Error('First unverified playlist has no saved SoundCloud URN');

async function get(url: string): Promise<any> {
  const parsed = new URL(url, api);
  if (parsed.origin !== api || parsed.protocol !== 'https:')
    throw new Error('Pagination origin rejected');
  const response = await fetch(parsed, {
    headers: { Authorization: `OAuth ${token.access_token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`SoundCloud GET HTTP ${response.status}`);
  return response.json();
}
async function pages(access: string | null, urn = playlistUrn) {
  const query = new URLSearchParams({ limit: '200', linked_partitioning: 'true' });
  if (access) query.set('access', access);
  let next: string | null = `${api}/playlists/${encodeURIComponent(urn)}/tracks?${query}`;
  const seen = new Set<string>();
  const tracks: any[] = [];
  let pagesRead = 0;
  while (next) {
    const url = new URL(next, api);
    if (url.origin !== api || seen.has(url.href))
      throw new Error('Invalid or looping pagination URL');
    seen.add(url.href);
    const body = await get(url.href);
    if (!Array.isArray(body.collection)) throw new Error('Malformed playlist tracks collection');
    tracks.push(...body.collection);
    pagesRead++;
    next = body.next_href || null;
  }
  return { tracks, pagesRead };
}
if (process.argv.includes('--verify-prior')) {
  for (let i = 0; i < index; i++) {
    const priorItem = plan.playlists[i];
    const prior = journal.playlists[priorItem.key];
    if (!prior?.verified || !prior.urn) continue;
    const readback = await pages('playable,preview,blocked', prior.urn);
    const actualUrns = readback.tracks.map((track) => track.urn);
    console.log(
      JSON.stringify({
        phase: 'verified-preflight',
        planIndex: i,
        playlistName: priorItem.title,
        playlistUrn: prior.urn,
        plannedCount: priorItem.urns.length,
        actualCount: actualUrns.length,
        pagesRead: readback.pagesRead,
        valid:
          priorItem.urns.length === actualUrns.length &&
          priorItem.urns.every((urn: string, n: number) => urn === actualUrns[n]),
      }),
    );
  }
}
const defaultRead = await pages(null);
const inclusiveRead = await pages('playable,preview,blocked');
const details = await get(`${api}/playlists/${encodeURIComponent(playlistUrn)}?show_tracks=true`);
const urnOf = (track: any) =>
  typeof track?.urn === 'string'
    ? track.urn
    : track?.id != null
      ? `soundcloud:tracks:${track.id}`
      : null;
const planned = item.urns as string[];
const actual = inclusiveRead.tracks.map(urnOf) as (string | null)[];
const duplicatePlannedUrns = [...new Set(planned)]
  .map((urn) => ({ urn, positions: planned.flatMap((v, i) => (v === urn ? [i] : [])) }))
  .filter((x) => x.positions.length > 1);
function difference(a: string[], b: (string | null)[]) {
  const counts = new Map<string, number>();
  for (const urn of b) if (urn) counts.set(urn, (counts.get(urn) || 0) + 1);
  return a.filter((urn) => {
    const remaining = counts.get(urn) || 0;
    if (!remaining) return true;
    counts.set(urn, remaining - 1);
    return false;
  });
}
const firstMismatchIndex = planned.findIndex((urn, i) => urn !== actual[i]);
const missingUrns = difference(planned, actual);
const unexpectedUrns = difference(
  actual.filter((x): x is string => !!x),
  planned,
);
const accessCounts = inclusiveRead.tracks.reduce((counts: Record<string, number>, track: any) => {
  const access = typeof track.access === 'string' ? track.access : 'unknown';
  counts[access] = (counts[access] || 0) + 1;
  return counts;
}, {});
const defaultUrns = defaultRead.tracks.map(urnOf);
const absentFromDefault = difference(planned, defaultUrns);
const uniqueMissing = [...new Set(missingUrns)];
const missingDetails = [];
for (const urn of uniqueMissing) {
  if (!/^soundcloud:tracks:\d+$/.test(urn)) continue;
  try {
    const track = await get(`${api}/tracks/${encodeURIComponent(urn)}`);
    missingDetails.push({
      urn,
      exists: true,
      access: track.access ?? null,
      streamable: track.streamable ?? null,
    });
  } catch (e) {
    missingDetails.push({ urn, exists: false, reason: (e as Error).message });
  }
}
const source = snapshot.playlists.find((playlist: any) => playlist.id === item.sourceId);
const sourceIds = source?.items.map((entry: any) => entry.spotifyTrackId).filter(Boolean) || [];
const showTracks = Array.isArray(details.tracks) ? details.tracks.map(urnOf) : null;
console.log(
  JSON.stringify({
    planIndex: index,
    playlistName: item.title,
    playlistUrn,
    plannedCount: planned.length,
    actualCount: actual.length,
    pagesRead: inclusiveRead.pagesRead,
    duplicatePlannedUrns,
    sourceDuplicateSpotifyTrackIds: sourceIds.length - new Set(sourceIds).size,
    firstMismatchIndex:
      firstMismatchIndex < 0 && actual.length !== planned.length
        ? Math.min(actual.length, planned.length)
        : firstMismatchIndex,
    expectedUrn:
      firstMismatchIndex >= 0
        ? (planned[firstMismatchIndex] ?? null)
        : (planned[actual.length] ?? null),
    actualUrn:
      firstMismatchIndex >= 0
        ? (actual[firstMismatchIndex] ?? null)
        : (actual[planned.length] ?? null),
    missingUrns,
    unexpectedUrns,
    missingDetails,
    accessCounts,
    defaultRead: {
      count: defaultRead.tracks.length,
      pagesRead: defaultRead.pagesRead,
      absentPlannedUrns: absentFromDefault,
    },
    showTracks: {
      count: showTracks?.length ?? null,
      sameOrderAsInclusive: showTracks
        ? JSON.stringify(showTracks) === JSON.stringify(actual)
        : null,
    },
    matchesFirstOccurrenceDedupedPlan:
      JSON.stringify([...new Set(planned)]) === JSON.stringify(actual),
  }),
);
