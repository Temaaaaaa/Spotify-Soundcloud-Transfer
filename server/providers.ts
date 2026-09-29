import type {
  Provider,
  SoundCloudTrack,
  SpotifyPlaylist,
  SpotifySnapshot,
  SpotifyTrack,
} from '../shared/types.js';
import { access, providers } from './auth.js';
import { ApiError, collectPages, HttpClient, safePageUrl } from './http.js';

export class ApiProvider {
  constructor(
    public name: Provider,
    private http = new HttpClient(),
  ) {}
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const url = safePageUrl(path, providers[this.name].api);
    return this.http.request(
      url,
      {
        method,
        headers: {
          Authorization: `${providers[this.name].scheme} ${await access(this.name)}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      this.name,
    );
  }
}
export const spotify = new ApiProvider('spotify');
export const soundcloud = new ApiProvider('soundcloud');
const spotifyOrigin = providers.spotify.api,
  scOrigin = providers.soundcloud.api;
function spotifyTrack(raw: any, addedAt: string | null): SpotifyTrack {
  const t = raw?.track ?? raw?.item ?? raw;
  return {
    id: String(t?.id || ''),
    title: String(t?.name || 'Unavailable track'),
    artists: Array.isArray(t?.artists) ? t.artists.map((a: any) => String(a.name || '')) : [],
    album: String(t?.album?.name || ''),
    duration_ms: Number.isFinite(t?.duration_ms) ? t.duration_ms : null,
    isrc: typeof t?.external_ids?.isrc === 'string' ? t.external_ids.isrc : null,
    url: typeof t?.external_urls?.spotify === 'string' ? t.external_urls.spotify : null,
    spotifyAddedAt: addedAt,
    unavailable: !t?.id || !!t?.is_local || t?.type !== 'track',
  };
}
function spotifyItems(page: any) {
  if (!Array.isArray(page?.items)) throw new Error('Invalid Spotify page');
  return page.items as any[];
}
export async function readSpotifySnapshot(
  request = (path: string) => spotify.request(path),
): Promise<SpotifySnapshot> {
  const account = await request('/v1/me');
  const saved = await collectPages(
    '/v1/me/tracks?limit=50',
    spotifyOrigin,
    request,
    spotifyItems,
    (p) => p.next || null,
  );
  const listed = await collectPages(
    '/v1/me/playlists?limit=50',
    spotifyOrigin,
    request,
    spotifyItems,
    (p) => p.next || null,
  );
  const tracks: Record<string, SpotifyTrack> = {},
    savedTracks: string[] = [];
  saved.forEach((item, index) => {
    const track = spotifyTrack(item, item.added_at || null);
    const key = track.id || `unavailable:saved:${index}`;
    track.id = key;
    tracks[key] = track;
    savedTracks.push(key);
  });
  const playlists: SpotifyPlaylist[] = [];
  for (let i = 0; i < listed.length; i++) {
    const p = listed[i];
    const playlist: SpotifyPlaylist = {
      id: String(p.id),
      name: String(p.name || ''),
      description: p.description ?? null,
      public: typeof p.public === 'boolean' ? p.public : null,
      collaborative: !!p.collaborative,
      ownerId: p.owner?.id ?? null,
      snapshotId: p.snapshot_id ?? null,
      sourceOrder: i,
      status: 'READY',
      items: [],
    };
    try {
      const items = await collectPages(
        `/v1/playlists/${encodeURIComponent(playlist.id)}/items?limit=50`,
        spotifyOrigin,
        request,
        spotifyItems,
        (page) => page.next || null,
      );
      playlist.items = items.map((item, position) => {
        const t = spotifyTrack(item, item.added_at || null);
        const key = t.id || `unavailable:${playlist.id}:${position}`;
        t.id = key;
        if (!tracks[key]) tracks[key] = t;
        return {
          position,
          added_at: item.added_at ?? null,
          spotifyTrackId: t.unavailable ? null : key,
          unavailable: !!t.unavailable,
        };
      });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 403 &&
        playlist.ownerId !== account?.id &&
        !playlist.collaborative
      ) {
        playlist.status = 'UNSUPPORTED_SOURCE_PLAYLIST';
        playlist.reason = 'NOT_OWNER_OR_COLLABORATOR';
      } else throw e;
    }
    playlists.push(playlist);
  }
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    accountId: account?.id ?? null,
    savedTracks,
    tracks,
    playlists,
  };
}
export function parseSoundCloudTrack(t: any): SoundCloudTrack {
  if (!t || typeof t.urn !== 'string' || !/^soundcloud:tracks:\d+$/.test(t.urn))
    throw new Error('Invalid SoundCloud track URN');
  return {
    urn: t.urn,
    id: t.id ?? null,
    title: String(t.title || ''),
    duration: Number.isFinite(t.duration) ? t.duration : null,
    isrc: typeof t.isrc === 'string' ? t.isrc : null,
    metadata_artist: typeof t.metadata_artist === 'string' ? t.metadata_artist : null,
    user: { username: t.user?.username, urn: t.user?.urn },
    permalink_url: t.permalink_url ?? null,
    access: t.access,
    streamable: t.streamable,
    release_year: t.release_year ?? null,
    created_at: t.created_at ?? null,
  };
}
function scItems(page: any) {
  if (!Array.isArray(page?.collection)) throw new Error('Invalid SoundCloud collection');
  return page.collection as any[];
}
export async function scCollectionDetailed(
  path: string,
  request = (p: string) => soundcloud.request(p),
  maxPages = Infinity,
) {
  let next: string | null = path;
  const seen = new Set<string>();
  const items: any[] = [];
  let pagesRead = 0;
  while (next) {
    const url = safePageUrl(next, scOrigin);
    if (seen.has(url)) throw new Error('Pagination loop');
    seen.add(url);
    const page = await request(url);
    items.push(...scItems(page));
    pagesRead++;
    if (pagesRead >= maxPages) break;
    if (page.next_href != null && typeof page.next_href !== 'string')
      throw new Error('Invalid pagination next_href');
    next = page.next_href || null;
  }
  return { items, pagesRead };
}
export async function scCollection(
  path: string,
  request = (p: string) => soundcloud.request(p),
  maxPages = Infinity,
) {
  return (await scCollectionDetailed(path, request, maxPages)).items;
}
export const soundCloudApi = {
  me: () => soundcloud.request('/me'),
  likes: async () =>
    (await scCollection('/me/likes/tracks?limit=200&linked_partitioning=true')).map(
      parseSoundCloudTrack,
    ),
  playlists: () =>
    scCollection('/me/playlists?limit=200&show_tracks=false&linked_partitioning=true'),
  search: async (q: string, limit = 100) =>
    (
      await scCollection(
        `/tracks?q=${encodeURIComponent(q)}&limit=${Math.min(200, Math.max(1, limit))}&linked_partitioning=true`,
        undefined,
        2,
      )
    ).map(parseSoundCloudTrack),
  track: async (urn: string) =>
    parseSoundCloudTrack(
      await soundcloud.request(`/tracks/${encodeURIComponent(validUrn(urn, 'tracks'))}`),
    ),
  playlist: (urn: string) =>
    soundcloud.request(`/playlists/${encodeURIComponent(validUrn(urn, 'playlists'))}`),
  playlistWithTracks: (urn: string) =>
    soundcloud.request(
      `/playlists/${encodeURIComponent(validUrn(urn, 'playlists'))}?show_tracks=true`,
    ),
  playlistTracksDetailed: async (urn: string) => {
    const result = await scCollectionDetailed(
      `/playlists/${encodeURIComponent(validUrn(urn, 'playlists'))}/tracks?limit=200&linked_partitioning=true&access=playable,preview,blocked`,
    );
    return { tracks: result.items.map(parseSoundCloudTrack), pagesRead: result.pagesRead };
  },
  playlistTracks: async (urn: string) => (await soundCloudApi.playlistTracksDetailed(urn)).tracks,
  like: (urn: string) =>
    soundcloud.request(`/likes/tracks/${encodeURIComponent(validUrn(urn, 'tracks'))}`, 'POST'),
  unlike: (urn: string) =>
    soundcloud.request(`/likes/tracks/${encodeURIComponent(validUrn(urn, 'tracks'))}`, 'DELETE'),
  createPlaylist: (title: string, urns: string[]) =>
    soundcloud.request('/playlists', 'POST', {
      playlist: {
        title,
        sharing: 'private',
        tracks: urns.map((urn) => ({ urn: validUrn(urn, 'tracks') })),
      },
    }),
  updatePlaylist: (urn: string, title: string, urns: string[]) =>
    soundcloud.request(`/playlists/${encodeURIComponent(validUrn(urn, 'playlists'))}`, 'PUT', {
      playlist: { title, tracks: urns.map((item) => ({ urn: validUrn(item, 'tracks') })) },
    }),
  deletePlaylist: (urn: string) =>
    soundcloud.request(`/playlists/${encodeURIComponent(validUrn(urn, 'playlists'))}`, 'DELETE'),
};
export function validUrn(urn: string, type: 'tracks' | 'playlists') {
  if (!new RegExp(`^soundcloud:${type}:\\d+$`).test(urn)) throw new Error(`Invalid ${type} URN`);
  return urn;
}
