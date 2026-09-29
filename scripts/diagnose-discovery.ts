// Read-only checkpoint inventory. Run: npx tsx scripts/diagnose-discovery.ts
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { orphanTemps } from '../server/storage.js';

const file = 'data/soundcloud-discovery.json';
let snapshotHash: string | null = null;
try {
  const snapshot = JSON.parse(await readFile('data/spotify-snapshot.json', 'utf8'));
  snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
} catch {
  /* Missing or invalid source snapshot is reported as incompatible. */
}

async function inspect(path: string) {
  try {
    const info = await stat(path);
    const value = JSON.parse(await readFile(path, 'utf8'));
    const mappings = value?.mappings;
    const valid =
      value?.schemaVersion === 2 &&
      typeof value?.snapshotHash === 'string' &&
      mappings &&
      typeof mappings === 'object' &&
      !Array.isArray(mappings);
    console.log(
      JSON.stringify({
        file: basename(path),
        exists: true,
        valid: !!valid,
        schemaVersion: value?.schemaVersion ?? null,
        snapshotCompatible: valid ? value.snapshotHash === snapshotHash : false,
        processed: valid ? Object.values(mappings).filter((m: any) => m?.processedAt).length : null,
        status: valid ? (value.status ?? null) : null,
        createdAt: value?.createdAt ?? null,
        updatedAt: value?.updatedAt ?? null,
        fileModifiedAt: info.mtime.toISOString(),
      }),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.log(
      JSON.stringify({
        file: basename(path),
        exists: code !== 'ENOENT',
        valid: false,
        error: code === 'ENOENT' ? null : 'invalid JSON or unreadable file',
      }),
    );
  }
}

await inspect(file);
for (const temp of await orphanTemps(file)) await inspect(temp);
