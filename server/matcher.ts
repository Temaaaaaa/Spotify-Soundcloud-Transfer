import type { Candidate, SoundCloudTrack, SpotifyTrack } from '../shared/types.js';
export const MATCHER_VERSION = '2.0.0';
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/(?<![\p{L}\p{N}])(?:featuring|feat|ft)(?![\p{L}\p{N}])\.?\s*/gu, ' feat ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const markers: [string, RegExp][] = [
  ['remix', /\bremix(?:ed)?\b/],
  ['extended mix', /\bextended mix\b/],
  ['radio edit', /\bradio edit\b/],
  ['mix', /\bmix\b/],
  ['edit', /\bedit\b/],
  ['sped up', /\b(?:sped|speed|speeded) up\b|\bspedup\b/],
  ['slowed', /\bslowed(?: down)?\b/],
  ['reverb', /\breverb\b/],
  ['nightcore', /\bnightcore\b/],
  ['cover', /\bcover\b/],
  ['live', /\blive\b/],
  ['instrumental', /\binstrumental\b/],
  ['karaoke', /\bkaraoke\b/],
  ['mashup', /\bmash ?up\b/],
  ['bootleg', /\bbootleg\b/],
  ['remaster', /\bremaster(?:ed)?\b/],
  ['acoustic', /\bacoustic\b/],
  ['demo', /\bdemo\b/],
  ['extended', /\bextended\b/],
];
export function versions(s: string) {
  const n = normalize(s);
  const found = markers.filter(([, re]) => re.test(n)).map(([name]) => name);
  return found.filter(
    (v) =>
      !(v === 'mix' && found.includes('extended mix')) &&
      !(v === 'edit' && found.includes('radio edit')) &&
      !(v === 'extended' && found.includes('extended mix')),
  );
}
function similarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const aWords = a.split(' ');
  const bWords = b.split(' ');
  const aa = new Set(aWords);
  const bb = new Set(bWords);
  const dice = (2 * [...aa].filter((t) => bb.has(t)).length) / (aa.size + bb.size);
  // Preserve order: reversed/reshuffled titles never look identical.
  return (
    dice *
    ((aWords.filter((t, i) => bWords[i] === t).length / Math.max(aWords.length, bWords.length)) *
      0.15 +
      0.85)
  );
}
function titleOnly(t: string, artists: string[]) {
  const parts = t.split(/\s+[—–-]\s+/u);
  if (parts.length > 1 && artists.some((a) => normalize(a) === normalize(parts[0]))) {
    return parts.slice(1).join(' - ');
  }
  const n = normalize(t);
  const prefix = artists
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((a) => n.startsWith(a + ' '));
  return prefix ? n.slice(prefix.length + 1) : t;
}
export const validIsrc = (s: string | null) => {
  const n = (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(n) ? n : '';
};
export const category = (n: number): Candidate['category'] =>
  n >= 90 ? 'VERIFIED' : n >= 65 ? 'REVIEW' : 'NOT_FOUND';
export function match(s: SpotifyTrack, c: SoundCloudTrack): Candidate {
  const reasons: string[] = [];
  const ct = titleOnly(c.title, s.artists);
  const title = similarity(normalize(s.title), normalize(ct));
  const meta = normalize(c.metadata_artist || '');
  const uploader = normalize(c.user.username || '');
  const primary = normalize(s.artists[0] || '');
  const artistSimilarity = (v: string) =>
    Math.max(
      similarity(primary, v),
      similarity(normalize(s.artists.join(' ')), v),
      v.split(' feat ')[0] === primary ? 1 : 0,
    );
  const artist = meta ? artistSimilarity(meta) : artistSimilarity(uploader) * 0.95;
  const delta = s.duration_ms && c.duration ? Math.abs(s.duration_ms - c.duration) : null;
  const tolerance = Math.max(3000, (s.duration_ms || 0) * 0.02);
  const duration =
    delta === null
      ? 0
      : delta <= tolerance
        ? 1
        : delta <= tolerance * 2
          ? 0.6
          : delta <= tolerance * 4
            ? 0.2
            : 0;
  const si = validIsrc(s.isrc);
  const ci = validIsrc(c.isrc);
  const sameIsrc = !!si && si === ci;
  const components = {
    title: +(title * 55).toFixed(2),
    artist: +(artist * 30).toFixed(2),
    duration: duration * 15,
    isrc: 0,
    penalties: 0,
  };
  let score = components.title + components.artist + components.duration;
  reasons.push(
    `Название: ${components.title}/55`,
    `Исполнитель: ${components.artist}/30 (${meta ? 'metadata_artist + uploader' : 'только uploader'})`,
    `Длительность: ${components.duration}/15; разница ${delta === null ? 'неизвестна' : delta + ' мс'}`,
  );
  if (sameIsrc) {
    components.isrc = Math.max(0, 99 - score);
    score += components.isrc;
    reasons.push('Совпадает валидный ISRC: база минимум 99');
  } else {
    reasons.push(si && ci ? 'ISRC различаются' : 'Сопоставимые ISRC отсутствуют');
  }
  let cap = 100;
  const limit = (n: number, why: string) => {
    cap = Math.min(cap, n);
    reasons.push(`Ограничение ${n}: ${why}`);
  };
  const sv = versions(s.title);
  const cv = versions(ct);
  const extra = cv.filter((v) => !sv.includes(v));
  const missing = sv.filter((v) => !cv.includes(v));
  if (extra.length) {
    components.penalties -= Math.min(90, extra.length * 45);
    limit(64, `другая версия: ${extra.join(', ')}`);
  }
  if (missing.length) {
    components.penalties -= 20;
    limit(89, `не подтверждена Spotify-версия: ${missing.join(', ')}`);
  }
  if (si && ci && !sameIsrc) {
    components.penalties -= 25;
    limit(89, 'конфликт ISRC');
  }
  if (sameIsrc && (title < 0.55 || artist < 0.55))
    limit(89, 'ISRC совпал, но метаданные противоречат');
  if (delta === null) {
    limit(89, 'неизвестная длительность');
  }
  if (delta !== null && delta > tolerance * 2) {
    limit(64, 'слишком большая разница длительности');
  }
  if (title < 0.55) {
    limit(64, 'слабое совпадение названия');
  } else if (title < 0.94) {
    limit(89, 'название требует проверки');
  }
  if (artist < 0.7) {
    limit(64, 'исполнитель не подтвержден');
  } else if (artist < 0.9 && !sameIsrc) {
    limit(89, 'исполнитель требует проверки');
  }
  if (meta && artistSimilarity(meta) < 0.7) {
    limit(89, 'metadata_artist противоречит исполнителю Spotify');
  }
  if (
    !sameIsrc &&
    s.artists
      .slice(1)
      .some(
        (a) =>
          !` ${normalize([c.title, c.metadata_artist, c.user.username].filter(Boolean).join(' '))} `.includes(
            ` ${normalize(a)} `,
          ),
      )
  ) {
    limit(89, 'не подтверждены все соисполнители Spotify');
  }
  if (s.unavailable || !s.title) {
    limit(0, 'Spotify-трек недоступен');
  }
  score = Math.max(0, Math.min(cap, Math.round(score + components.penalties)));
  return { track: c, score, category: category(score), reasons, components };
}
export function rank(s: SpotifyTrack, tracks: SoundCloudTrack[]): Candidate[] {
  const candidates = [...new Map(tracks.map((t) => [t.urn, t])).values()]
    .map((c) => match(s, c))
    .sort((a, b) => b.score - a.score || a.track.urn.localeCompare(b.track.urn));
  if (
    candidates[0]?.score >= 90 &&
    candidates[1]?.score >= 90 &&
    candidates[0].score - candidates[1].score < 5
  ) {
    for (const c of candidates.filter((c) => c.score >= 90)) {
      c.score = 89;
      c.category = 'REVIEW';
      c.reasons.push('Ограничение 89: несколько почти равных кандидатов; нужна ручная проверка');
    }
  }
  return candidates.slice(0, 5);
}
