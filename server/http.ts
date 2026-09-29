export class ApiError extends Error {
  constructor(
    public status: number,
    public provider: string,
    public retryAfter: string | null = null,
    public safeBody: string = '',
  ) {
    super(`${provider}: HTTP ${status}`);
  }
}
export class UnknownOutcome extends Error {
  constructor() {
    super('Network result unknown; read back state before retry');
  }
}
export function retryDelay(value: string | null, attempt: number, now = Date.now()) {
  const parsed =
    value === null
      ? NaN
      : /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value) - now;
  return Math.min(
    30000,
    Math.max(Number.isFinite(parsed) ? parsed : 0, 500 * 2 ** attempt + Math.random() * 250),
  );
}
export class HttpClient {
  constructor(
    private fetcher: typeof fetch = fetch,
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async request(url: string, init: RequestInit = {}, label = 'API'): Promise<any> {
    const get = !init.method || init.method.toUpperCase() === 'GET';
    for (let attempt = 0; attempt < (get ? 5 : 1); attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (!get) throw new UnknownOutcome();
        if (attempt === 4) throw new Error(`${label}: network failure`);
        await this.sleep(retryDelay(null, attempt));
        continue;
      }
      if (get && (response.status === 429 || response.status >= 500) && attempt < 4) {
        await this.sleep(retryDelay(response.headers.get('retry-after'), attempt));
        continue;
      }
      if (!response.ok) {
        const raw = (await response.text()).slice(0, 2000);
        const secrets = [
          process.env.SPOTIFY_CLIENT_ID,
          process.env.SPOTIFY_CLIENT_SECRET,
          process.env.SOUNDCLOUD_CLIENT_ID,
          process.env.SOUNDCLOUD_CLIENT_SECRET,
          (init.headers as Record<string, string> | undefined)?.Authorization,
        ].filter((x): x is string => !!x);
        let safe = raw;
        for (const value of secrets) safe = safe.split(value).join('[REDACTED]');
        safe = safe
          .replace(
            /(?:access_token|refresh_token|client_secret|code_verifier|code)\s*[=:]\s*[^,\s}]+/gi,
            '[REDACTED]',
          )
          .replace(/[A-Za-z0-9_+\/-]{24,}={0,2}/g, '[REDACTED]')
          .replace(/[\r\n\x00-\x1F]/g, ' ')
          .slice(0, 500);
        throw new ApiError(response.status, label, response.headers.get('retry-after'), safe);
      }
      const body = await response.text();
      if (!body) return null;
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`${label}: invalid JSON`);
      }
    }
    throw new Error(`${label}: retry limit`);
  }
}
export function safePageUrl(path: string, origin: string) {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:')
    throw new Error('Pagination origin rejected');
  return url.toString();
}
export async function collectPages<T>(
  first: string,
  origin: string,
  request: (url: string) => Promise<any>,
  items: (page: any) => T[],
  next: (page: any) => string | null,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let pageUrl: string | null = first;
  while (pageUrl) {
    const url = safePageUrl(pageUrl, origin);
    if (seen.has(url)) throw new Error('Pagination loop');
    seen.add(url);
    const page = await request(url);
    result.push(...items(page));
    pageUrl = next(page);
  }
  return result;
}
