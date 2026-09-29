import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const delays = [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000];
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StorageError extends Error {
  readonly code = 'STORAGE_WRITE_FAILED';
  constructor(
    readonly file: string,
    readonly tempFile: string,
    readonly fsCode: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `Storage write failed (${fsCode}) after ${attempts} rename attempt(s); checkpoint remains at ${file}, recovery file: ${tempFile}`,
      { cause },
    );
    this.name = 'StorageError';
  }
}

// Inject only rename and timer in tests; production uses the filesystem primitives.
export async function atomic(
  file: string,
  content: string,
  options: { rename?: typeof rename; wait?: typeof sleep; delays?: number[] } = {},
) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const retryDelays = options.delays ?? delays;
  const renameFile = options.rename ?? rename;
  const isPresent = async (path: string) => {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  for (let attempt = 1; ; attempt++) {
    try {
      await renameFile(temp, file);
      return;
    } catch (cause) {
      const fsCode = (cause as NodeJS.ErrnoException).code || 'UNKNOWN';
      if (!transient.has(fsCode) || attempt > retryDelays.length) {
        if (transient.has(fsCode) && (await isPresent(file))) {
          const backup = `${file}.${randomUUID()}.bak`;
          try {
            await renameFile(file, backup);
            try {
              await renameFile(temp, file);
              await unlink(backup).catch(() => {});
              return;
            } catch (replacementError) {
              await renameFile(backup, file).catch(() => {});
              throw new StorageError(
                file,
                temp,
                (replacementError as NodeJS.ErrnoException).code || fsCode,
                attempt,
                replacementError,
              );
            }
          } catch (fallbackError) {
            if (fallbackError instanceof StorageError) throw fallbackError;
            throw new StorageError(
              file,
              temp,
              (fallbackError as NodeJS.ErrnoException).code || fsCode,
              attempt,
              fallbackError,
            );
          }
        }
        throw new StorageError(file, temp, fsCode, attempt, cause);
      }
      await (options.wait ?? sleep)(retryDelays[attempt - 1]);
    }
  }
}

export async function saveJson(file: string, value: unknown) {
  await atomic(file, JSON.stringify(value, null, 2));
}

export async function loadJson<T>(
  file: string,
  validate: (value: any) => value is T,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Corrupted data file: ${file}`);
  }
  if (!validate(parsed)) throw new Error(`Unsupported or corrupted data file: ${file}`);
  return parsed;
}

export async function orphanTemps(file: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dirname(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const prefix = `${basename(file)}.`;
  return entries
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(
          name.slice(prefix.length),
        ),
    )
    .map((name) => join(dirname(file), name));
}

export async function orphanBackups(file: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dirname(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const prefix = `${basename(file)}.`;
  return entries
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bak$/i.test(
          name.slice(prefix.length),
        ),
    )
    .map((name) => join(dirname(file), name));
}

export async function recoverJson<T>(
  file: string,
  validate: (value: any) => value is T,
  isNewer: (candidate: T, canonical: T | null) => boolean,
): Promise<T | null> {
  let canonical: T | null;
  try {
    canonical = await loadJson(file, validate);
  } catch {
    console.warn(`Storage warning: invalid canonical JSON at ${file}; checking recovery files`);
    canonical = null;
  }
  if (!canonical) {
    for (const backup of await orphanBackups(file)) {
      try {
        const candidate = await loadJson(backup, validate);
        if (candidate) {
          await atomic(file, JSON.stringify(candidate, null, 2));
          canonical = candidate;
          await unlink(backup).catch(() => {});
          console.warn(`Storage recovered ${file} from ${backup}`);
          break;
        }
      } catch {
        console.warn(`Storage warning: invalid backup file ${backup}; preserved`);
      }
    }
  }
  const temps = await orphanTemps(file);
  let chosen: { file: string; value: T } | null = null;
  for (const temp of temps) {
    let candidate: T | null;
    try {
      candidate = await loadJson(temp, validate);
    } catch {
      console.warn(`Storage warning: invalid recovery file ${temp}; preserved`);
      continue;
    }
    if (candidate && isNewer(candidate, chosen?.value ?? canonical))
      chosen = { file: temp, value: candidate };
    else console.warn(`Storage warning: unproven recovery file ${temp}; preserved`);
  }
  if (chosen) {
    try {
      await atomic(file, JSON.stringify(chosen.value, null, 2));
      canonical = chosen.value;
      await unlink(chosen.file).catch(() => {});
      console.warn(`Storage recovered ${file} from ${chosen.file}`);
    } catch (e) {
      if (!canonical) throw e;
      console.warn(
        `Storage warning: could not promote ${chosen.file}; canonical ${file} preserved`,
      );
    }
  }
  if (!canonical) {
    const exists = await readFile(file).then(
      () => true,
      (e) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
      },
    );
    if (exists) throw new Error(`Corrupted data file: ${file}; no compatible recovery file`);
  }
  return canonical;
}
