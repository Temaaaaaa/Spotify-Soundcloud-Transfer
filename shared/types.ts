export type Provider = 'spotify' | 'soundcloud';
export interface SpotifyTrack {
  id: string;
  title: string;
  artists: string[];
  album: string;
  duration_ms: number | null;
  isrc: string | null;
  url: string | null;
  spotifyAddedAt?: string | null;
  unavailable?: boolean;
}
export interface PlaylistItem {
  position: number;
  added_at: string | null;
  spotifyTrackId: string | null;
  unavailable: boolean;
}
export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  ownerId: string | null;
  snapshotId: string | null;
  sourceOrder: number;
  status: 'READY' | 'UNSUPPORTED_SOURCE_PLAYLIST';
  reason?: 'NOT_OWNER_OR_COLLABORATOR';
  items: PlaylistItem[];
}
export interface SpotifySnapshot {
  schemaVersion: 2;
  createdAt: string;
  accountId: string | null;
  savedTracks: string[];
  tracks: Record<string, SpotifyTrack>;
  playlists: SpotifyPlaylist[];
}
export interface SoundCloudTrack {
  urn: string;
  id?: string | number | null;
  title: string;
  duration: number | null;
  isrc: string | null;
  metadata_artist: string | null;
  user: { username?: string; urn?: string };
  permalink_url: string | null;
  access?: string;
  streamable?: boolean;
  release_year?: number | null;
  created_at?: string | null;
}
export type MappingStatus =
  | 'VERIFIED'
  | 'REVIEW'
  | 'AUTO_BEST_MATCH'
  | 'NOT_FOUND'
  | 'HARD_REJECTED_ALL'
  | 'SOURCE_UNAVAILABLE'
  | 'API_BLOCKED';
export interface Candidate {
  track: SoundCloudTrack;
  score: number;
  category: 'VERIFIED' | 'REVIEW' | 'NOT_FOUND';
  reasons: string[];
  components: { title: number; artist: number; duration: number; isrc: number; penalties: number };
}
export interface Mapping {
  spotifyTrackId: string;
  status: MappingStatus;
  matchMethod: 'ISRC' | 'METADATA' | 'MANUAL' | 'AGGRESSIVE_BEST_MATCH' | null;
  score: number | null;
  reasons: string[];
  matcherVersion: string;
  candidates: Candidate[];
  acceptedUrn: string | null;
  selectedSoundCloudUrn?: string | null;
  aggressive?: boolean;
  decision: 'pending' | 'accepted' | 'rejected' | 'skipped';
  processedAt: string | null;
}
export interface Discovery {
  schemaVersion: 2;
  snapshotHash: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'blocked';
  error: string | null;
  mappings: Record<string, Mapping>;
}
export type MatchingMode = 'STRICT' | 'AGGRESSIVE_BEST_MATCH';
export interface AggressiveDiscovery {
  schemaVersion: 3;
  snapshotHash: string;
  sourceDiscoveryHash: string;
  status: 'running' | 'paused' | 'completed' | 'blocked';
  error: string | null;
  overrides: Record<string, Mapping>;
}
export interface SoundCloudBackup {
  schemaVersion: 2;
  accountUrn: string;
  username: string;
  createdAt: string;
  complete: boolean;
  likes: SoundCloudTrack[];
  playlists: { urn: string; title: string; tracks: SoundCloudTrack[] }[];
}
export interface PlaylistPlan {
  key: string;
  sourceId: string | null;
  title: string;
  urns: string[];
  kind?: 'SOURCE_PLAYLIST' | 'LIKES_STAGING';
}
export interface MigrationPlan {
  schemaVersion: 2;
  id: string;
  createdAt: string;
  snapshotHash: string;
  targetAccountUrn: string;
  matcherVersion: string;
  matchingMode?: MatchingMode;
  mappingSummary?: { verified: number; aggressive: number; skipped: number };
  acceptedMappings: Record<string, string>;
  existingLikes: string[];
  plannedLikes: { spotifyTrackId: string; urn: string; addedAt: string | null }[];
  playlists: PlaylistPlan[];
  unsupported: string[];
  notFound: string[];
  backupFile: string;
}
export interface Operation {
  spotifyTrackId: string | null;
  soundcloudUrn: string;
  startedAt: string;
  finishedAt: string;
  stateBefore: string;
  requestOutcome: string;
  stateAfter: string;
}
export type PlaylistVerificationStatus =
  | 'VERIFIED'
  | 'COUNT_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'UNSUPPORTED_DUPLICATE_OCCURRENCES'
  | 'UNSUPPORTED_DUPLICATE_OCCURRENCES_ACCEPTED';
export interface PlaylistMismatchReport {
  playlistName: string;
  playlistUrn: string;
  plannedCount: number;
  actualCount: number;
  pagesRead: number;
  duplicatePlannedUrns: { urn: string; positions: number[] }[];
  firstMismatchIndex: number | null;
  expectedUrn: string | null;
  actualUrn: string | null;
  missingUrns: string[];
  unexpectedUrns: string[];
  accessCounts: Record<string, number>;
  missingTrackDetails: { urn: string; access: string | null; reason: string | null }[];
  showTracksCount: number | null;
  showTracksMatchesReadBack: boolean | null;
}
export interface Journal {
  schemaVersion: 2;
  planId: string;
  accountUrn: string;
  playlists: Record<
    string,
    {
      urn: string;
      verified: boolean;
      verificationStatus?: PlaylistVerificationStatus;
      mismatch?: PlaylistMismatchReport;
      duplicateFallbackAccepted?: boolean;
      stagingStatus?: 'VERIFIED' | 'PARTIAL' | 'SKIPPED';
    }
  >;
  likes: Record<string, Operation>;
  status:
    | 'idle'
    | 'running'
    | 'RESUMING'
    | 'paused'
    | 'PAUSED_STORAGE_ERROR'
    | 'RATE_LIMITED'
    | 'UNKNOWN'
    | 'completed';
  rateLimit?: {
    detectedAt: string;
    retryAfterSeconds: number | null;
    retryAt: string | null;
    upstreamStatus: 429;
  } | null;
  unknownPlaylistKey?: string;
  likeOrder: 'unknown' | 'newest-first' | 'oldest-first';
}
