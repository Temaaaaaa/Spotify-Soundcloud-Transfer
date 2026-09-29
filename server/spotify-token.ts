import { readFile } from 'node:fs/promises';
import { envFile } from './environment.js';
import { atomic } from './storage.js';

export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:3000/auth/spotify/callback';
export type SpotifyToken = { access_token: string; refresh_token: string; expires_at: number };
export type SpotifyTokenDiagnostic = {
  provider: 'spotify';
  phase: 'request' | 'response' | 'parsed' | 'validated' | 'persist';
  hostname: 'accounts.spotify.com';
  method: 'POST';
  status?: number;
  contentType?: string | null;
  error?: string;
  error_description?: string;
  responseReached: boolean;
  responseBodyParsed: boolean;
  tokenSchemaValid: boolean;
  persistenceSucceeded: boolean;
  networkErrorCode?: string;
  networkErrorName?: string;
};
export type SpotifyDiagnosticSink = (record: SpotifyTokenDiagnostic) => void;
export const logSpotifyDiagnostic: SpotifyDiagnosticSink = (record) =>
  console.info('[spotify-oauth]', JSON.stringify(record));
export class SpotifyTokenError extends Error {
  constructor(
    public code:
      | 'TOKEN_EXCHANGE_NETWORK'
      | 'TOKEN_EXCHANGE_UNKNOWN'
      | 'TOKEN_HTTP_ERROR'
      | 'TOKEN_RESPONSE_INVALID'
      | 'TOKEN_PERSIST_FAILED',
    detail: string,
    public status?: number,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SpotifyTokenError';
  }
}
const base = { provider: 'spotify', hostname: 'accounts.spotify.com', method: 'POST' } as const;
function safeNetwork(error: unknown) {
  const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const raw = e?.cause?.code ?? e?.code;
  const code =
    typeof raw === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z_]+|ERR_[A-Z_]+)$/.test(raw)
      ? raw
      : 'FETCH_FAILED';
  const name = typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
  return { code, name };
}
function safeError(value: unknown, secrets: string[]) {
  if (typeof value !== 'string') return undefined;
  let result = value;
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join('[REDACTED]');
    result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return result
    .replace(/(?:Basic|Bearer|OAuth)\s+\S+/gi, '[REDACTED]')
    .replace(
      /(?:access_token|refresh_token|client_secret|code_verifier|code)\s*[:=]\s*[^\s,;"}]+/gi,
      '[REDACTED]',
    )
    .replace(/[A-Za-z0-9_+\/-]{24,}={0,2}/g, '[REDACTED]')
    .replace(/[\r\n\x00-\x1F]/g, ' ')
    .slice(0, 200);
}
function tokenShape(
  value: any,
  initial: boolean,
  oldRefresh: string | undefined,
): value is {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expires_in: number;
} {
  return (
    !!value &&
    typeof value.access_token === 'string' &&
    !!value.access_token &&
    value.token_type === 'Bearer' &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0 &&
    (!initial ||
      (typeof value.scope === 'string' &&
        typeof value.refresh_token === 'string' &&
        !!value.refresh_token)) &&
    (initial || typeof value.refresh_token === 'string' || !!oldRefresh)
  );
}
export async function exchangeSpotifyToken(
  clientId: string,
  clientSecret: string,
  fields:
    | { grant_type: 'authorization_code'; code: string; redirect_uri: string }
    | { grant_type: 'refresh_token'; refresh_token: string },
  oldRefresh?: string,
  fetcher: typeof fetch = fetch,
  log: SpotifyDiagnosticSink = logSpotifyDiagnostic,
): Promise<SpotifyToken> {
  const initial = fields.grant_type === 'authorization_code';
  const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const secrets = [
    clientId,
    clientSecret,
    authorization,
    initial ? fields.code : fields.refresh_token,
    oldRefresh || '',
  ];
  log({
    ...base,
    phase: 'request',
    responseReached: false,
    responseBodyParsed: false,
    tokenSchemaValid: false,
    persistenceSucceeded: false,
  });
  let response: Response;
  try {
    response = await fetcher(SPOTIFY_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: authorization,
      },
      body: new URLSearchParams(fields),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    const network = safeNetwork(e);
    log({
      ...base,
      phase: 'response',
      responseReached: false,
      responseBodyParsed: false,
      tokenSchemaValid: false,
      persistenceSucceeded: false,
      networkErrorCode: network.code,
      networkErrorName: network.name,
    });
    const beforeConnect =
      /^(?:EACCES|EPERM|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$/.test(
        network.code,
      );
    throw new SpotifyTokenError(
      beforeConnect ? 'TOKEN_EXCHANGE_NETWORK' : 'TOKEN_EXCHANGE_UNKNOWN',
      network.code,
    );
  }
  const contentType = response.headers.get('content-type');
  log({
    ...base,
    phase: 'response',
    status: response.status,
    contentType,
    responseReached: true,
    responseBodyParsed: false,
    tokenSchemaValid: false,
    persistenceSucceeded: false,
  });
  let payload: any;
  let parsed = false;
  try {
    payload = JSON.parse(await response.text());
    parsed = true;
  } catch {
    payload = null;
  }
  const responseSecrets = [
    ...secrets,
    payload?.access_token,
    payload?.refresh_token,
    payload?.code,
    payload?.client_secret,
  ].filter((x): x is string => typeof x === 'string');
  const error = safeError(payload?.error, responseSecrets);
  const error_description = safeError(payload?.error_description, responseSecrets);
  log({
    ...base,
    phase: 'parsed',
    status: response.status,
    contentType,
    responseReached: true,
    responseBodyParsed: parsed,
    tokenSchemaValid: false,
    persistenceSucceeded: false,
    ...(error ? { error } : {}),
    ...(error_description ? { error_description } : {}),
  });
  if (response.status !== 200)
    throw new SpotifyTokenError(
      'TOKEN_HTTP_ERROR',
      `HTTP ${response.status}${error ? ` ${error}` : ''}${error_description ? `: ${error_description}` : ''}`,
      response.status,
    );
  if (!parsed || !tokenShape(payload, initial, oldRefresh))
    throw new SpotifyTokenError('TOKEN_RESPONSE_INVALID', 'HTTP 200 token JSON/schema invalid');
  log({
    ...base,
    phase: 'validated',
    status: response.status,
    contentType,
    responseReached: true,
    responseBodyParsed: true,
    tokenSchemaValid: true,
    persistenceSucceeded: false,
  });
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || oldRefresh!,
    expires_at: Date.now() + payload.expires_in * 1000,
  };
}
let persistTail: Promise<unknown> = Promise.resolve();
async function writeSpotifyValues(
  values: Record<'SPOTIFY_ACCESS_TOKEN' | 'SPOTIFY_REFRESH_TOKEN' | 'SPOTIFY_EXPIRES_AT', string>,
  file: string,
) {
  const task = persistTail.then(async () => {
    const content = await readFile(file, 'utf8').catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    });
    const old = content
      .split(/\r?\n/)
      .filter((line) => !/^\s*SPOTIFY_(?:ACCESS_TOKEN|REFRESH_TOKEN|EXPIRES_AT)\s*=/.test(line));
    const entries = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    await atomic(file, [...old.filter(Boolean), ...entries, ''].join('\n'));
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  });
  persistTail = task.catch(() => {});
  await task;
}
export async function persistSpotifyToken(
  token: SpotifyToken,
  file = envFile,
  log: SpotifyDiagnosticSink = logSpotifyDiagnostic,
) {
  try {
    await writeSpotifyValues(
      {
        SPOTIFY_ACCESS_TOKEN: token.access_token,
        SPOTIFY_REFRESH_TOKEN: token.refresh_token,
        SPOTIFY_EXPIRES_AT: String(token.expires_at),
      },
      file,
    );
    log({
      ...base,
      phase: 'persist',
      responseReached: true,
      responseBodyParsed: true,
      tokenSchemaValid: true,
      persistenceSucceeded: true,
    });
  } catch {
    log({
      ...base,
      phase: 'persist',
      responseReached: true,
      responseBodyParsed: true,
      tokenSchemaValid: true,
      persistenceSucceeded: false,
    });
    throw new SpotifyTokenError('TOKEN_PERSIST_FAILED', 'Atomic token storage failed');
  }
}
export async function clearSpotifyToken(file = envFile) {
  await writeSpotifyValues(
    { SPOTIFY_ACCESS_TOKEN: '', SPOTIFY_REFRESH_TOKEN: '', SPOTIFY_EXPIRES_AT: '0' },
    file,
  );
}
export function spotifyTokenFromEnvironment(): SpotifyToken | null {
  const access_token = process.env.SPOTIFY_ACCESS_TOKEN || '';
  const refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || '';
  const expires_at = Number(process.env.SPOTIFY_EXPIRES_AT);
  return access_token && refresh_token && Number.isFinite(expires_at)
    ? { access_token, refresh_token, expires_at }
    : null;
}
