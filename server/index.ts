import './environment.js';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  begin,
  callback,
  configured,
  connected,
  disconnect,
  initializeAuth,
  origin,
  port,
} from './auth.js';
import { ApiError, UnknownOutcome } from './http.js';
import { soundCloudApi } from './providers.js';
import { Workflow } from './workflow.js';
import { SpotifyTokenError } from './spotify-token.js';
import { PlaylistMismatchError } from './playlist-verification.js';

await initializeAuth();
const workflow = new Workflow();
await workflow.init();
let operationBusy = false;
async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  if (operationBusy || workflow.job.running || workflow.guided.running)
    throw new Error('Another operation is running');
  operationBusy = true;
  try {
    return await action();
  } finally {
    operationBusy = false;
  }
}
const app = express();
const csrf = randomBytes(32).toString('base64url');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers.host !== `127.0.0.1:${port}`)
    return res.status(403).json({ error: 'Invalid Host' });
  if (
    req.method !== 'GET' &&
    (req.headers.origin !== origin || req.headers['x-csrf-token'] !== csrf)
  )
    return res.status(403).json({ error: 'CSRF check failed' });
  next();
});
app.use(express.json({ limit: '64kb' }));
const provider = z.enum(['spotify', 'soundcloud']);
const string = z.string().trim().min(1).max(300);
app.get('/api/state', (_req, res) =>
  res.json({
    csrf,
    auth: {
      spotify: { configured: configured('spotify'), connected: connected('spotify') },
      soundcloud: { configured: configured('soundcloud'), connected: connected('soundcloud') },
    },
    snapshot: workflow.snapshot,
    discovery: workflow.activeDiscovery()
      ? {
          ...workflow.activeDiscovery()!,
          error: workflow.currentDiscoveryError(),
          historicalError: workflow.historicalDiscoveryError(),
        }
      : null,
    matchingMode: workflow.matchingMode,
    aggressive: workflow.aggressive && {
      status: workflow.aggressive.status,
      processed: Object.keys(workflow.aggressive.overrides).length,
      summary: workflow.aggressiveSummary(),
      error: workflow.aggressive.error,
    },
    aggressivePreview: workflow.discovery ? workflow.aggressivePreview() : null,
    backup: workflow.backup && {
      accountUrn: workflow.backup.accountUrn,
      username: workflow.backup.username,
      complete: workflow.backup.complete,
      likesCount: workflow.backup.likes.length,
      playlistCount: workflow.backup.playlists.length,
    },
    plan: workflow.plan,
    journal: workflow.journal,
    job: workflow.job,
    guided: workflow.guided,
  }),
);
app.get('/auth/:provider', (req, res) => {
  if (operationBusy || workflow.job.running) throw new Error('Wait for the current operation');
  const p = provider.parse(req.params.provider),
    auth = begin(p);
  res.cookie(`oauth_${p}`, auth.state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600000,
    path: `/auth/${p}/callback`,
  });
  res.redirect(auth.url);
});
app.get('/auth/:provider/callback', async (req, res) => {
  if (operationBusy || workflow.job.running) throw new Error('Wait for the current operation');
  const p = provider.parse(req.params.provider);
  const cookie =
    (req.headers.cookie || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`oauth_${p}=`))
      ?.split('=')[1] || '';
  res.clearCookie(`oauth_${p}`, { path: `/auth/${p}/callback` });
  await callback(p, String(req.query.state || ''), cookie, String(req.query.code || ''));
  res.redirect('/');
});
app.post('/api/auth/:provider/disconnect', async (req, res) => {
  if (operationBusy || workflow.job.running) throw new Error('Wait for the current operation');
  await disconnect(provider.parse(req.params.provider));
  res.json({ ok: true });
});
app.get('/api/soundcloud/me', async (_req, res) => {
  const me = await soundCloudApi.me();
  const [likes, playlists] = await Promise.all([soundCloudApi.likes(), soundCloudApi.playlists()]);
  res.json({
    connected: true,
    username: me.username ?? null,
    urn: me.urn ?? null,
    plan: me.plan ?? null,
    likesCount: me.likes_count ?? likes.length,
    playlistCount: playlists.length,
    apiStatus: 'OK',
  });
});
app.post('/api/soundcloud/diagnostics/search', async (req, res) => {
  const q = z.object({ query: string }).parse(req.body);
  res.json(await soundCloudApi.search(q.query, 20));
});
app.post('/api/soundcloud/diagnostics/track', async (req, res) => {
  const body = z.object({ urn: string }).parse(req.body);
  res.json(await soundCloudApi.track(body.urn));
});
app.post('/api/snapshot/spotify', async (_req, res) =>
  res.json(await exclusive(() => workflow.snapshotSpotify())),
);
app.post('/api/backup/soundcloud', async (_req, res) =>
  res.json(await exclusive(() => workflow.backupSoundCloud())),
);
app.post('/api/discovery/start', (_req, res) => {
  if (operationBusy) throw new Error('Another operation is running');
  workflow.startDiscovery();
  res.status(202).json({ ok: true });
});
app.post('/api/discovery/pause', (_req, res) => {
  workflow.pauseDiscovery();
  res.json({ ok: true });
});
app.post('/api/discovery/resume', (_req, res) => {
  if (operationBusy) throw new Error('Another operation is running');
  workflow.startDiscovery();
  res.status(202).json({ ok: true });
});
app.post('/api/matching/aggressive/start', (_req, res) => {
  if (operationBusy) throw new Error('Another operation is running');
  workflow.startAggressive();
  res.status(202).json({ ok: true });
});
app.post('/api/matching/mode', (req, res) => {
  const mode = z.enum(['STRICT', 'AGGRESSIVE_BEST_MATCH']).parse(req.body.mode);
  workflow.setMatchingMode(mode);
  res.json({ mode });
});
app.post('/api/mapping/search', async (req, res) => {
  const b = z.object({ id: string, query: string }).parse(req.body);
  res.json(await workflow.manualSearch(b.id, b.query));
});
app.post('/api/mapping/decision', async (req, res) => {
  const b = z
    .object({
      id: string,
      action: z.enum(['accept', 'reject', 'skip']),
      urn: z.string().optional(),
    })
    .parse(req.body);
  await workflow.decide(b.id, b.action, b.urn);
  res.json({ ok: true });
});
app.post('/api/migration/prepare', async (_req, res) =>
  res.json(await exclusive(() => workflow.prepare())),
);
app.post('/api/flow/scan', async (_req, res) =>
  res.json(
    await exclusive(async () => {
      if (!workflow.snapshot) await workflow.snapshotSpotify();
      if (!workflow.backup?.complete) await workflow.backupSoundCloud();
      return { ok: true };
    }),
  ),
);
app.post('/api/flow/match', (_req, res) => {
  if (operationBusy || workflow.job.running || workflow.guided.running)
    throw new Error('Another operation is running');
  if (workflow.discovery?.status !== 'completed') workflow.startDiscovery();
  else if (workflow.aggressive?.status !== 'completed') workflow.startAggressive();
  else workflow.setMatchingMode('AGGRESSIVE_BEST_MATCH');
  res.status(202).json({ ok: true });
});
app.post('/api/flow/transfer', async (req, res) => {
  z.object({ confirmed: z.literal(true) }).parse(req.body);
  if (operationBusy) throw new Error('Another operation is running');
  const result = await workflow.startGuidedTransfer();
  res.status(result?.ok ? 202 : 200).json(result);
});
app.post('/api/migration/acceptance/playlist', async (req, res) => {
  const b = z.object({ confirmation: string }).parse(req.body);
  // A one-playlist write acceptance run: execute exactly the first pending playlist.
  res.json(await exclusive(() => workflow.executePlaylists(b.confirmation, 1)));
});
app.post('/api/migration/acceptance/like-order', async (req, res) => {
  const b = z
    .object({ urns: z.array(z.string()).min(2).max(3), confirmation: string })
    .parse(req.body);
  res.json(await exclusive(() => workflow.likeOrderTest(b.urns, b.confirmation)));
});
app.post('/api/migration/execute/playlists', async (req, res) => {
  const b = z.object({ confirmation: string }).parse(req.body);
  res.json(await exclusive(() => workflow.executePlaylists(b.confirmation)));
});
app.post('/api/migration/diagnose-first-unverified', async (_req, res) =>
  res.json(await exclusive(() => workflow.diagnoseFirstUnverifiedPlaylist())),
);
app.post('/api/migration/accept-duplicate-fallback', async (req, res) => {
  const body = z.object({ key: z.string(), confirmation: z.string() }).parse(req.body);
  res.json(await exclusive(() => workflow.acceptDuplicateFallback(body.key, body.confirmation)));
});
app.post('/api/migration/execute/likes', async (req, res) => {
  const b = z.object({ confirmation: string }).parse(req.body);
  res.json(await exclusive(() => workflow.executeLikes(b.confirmation)));
});
app.post('/api/migration/pause', (_req, res) => {
  workflow.pause();
  res.json({ ok: true });
});
app.post('/api/audit', async (_req, res) => res.json(await exclusive(() => workflow.audit())));
if (existsSync('dist/index.html')) app.use(express.static('dist'));
else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      err instanceof z.ZodError
        ? 400
        : err instanceof PlaylistMismatchError
          ? 409
          : err instanceof SpotifyTokenError
            ? err.status === 400 || err.status === 401
              ? err.status
              : err.code === 'TOKEN_PERSIST_FAILED'
                ? 500
                : 502
            : err instanceof ApiError
              ? err.status === 429
                ? 429
                : 502
              : err instanceof UnknownOutcome
                ? 503
                : 400;
    res.status(status).json({
      ...(err instanceof PlaylistMismatchError ? { type: err.status, mismatch: err.report } : {}),
      ...(err instanceof SpotifyTokenError
        ? { type: err.code, ...(err.status ? { upstreamStatus: err.status } : {}) }
        : {}),
      error:
        err instanceof ApiError
          ? `Upstream HTTP ${err.status}`
          : err instanceof z.ZodError
            ? 'Invalid request'
            : err instanceof Error
              ? err.message.replace(/(?:Bearer|OAuth|Basic)\s+\S+/g, '[REDACTED]')
              : 'Request failed',
    });
  },
);
app.listen(port, '127.0.0.1', () => console.log(`Spotify → SoundCloud Migrator: ${origin}`));
