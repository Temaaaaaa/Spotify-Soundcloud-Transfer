import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomic,
  loadJson,
  orphanBackups,
  orphanTemps,
  recoverJson,
  saveJson,
  StorageError,
} from '../server/storage.js';
test('atomic JSON roundtrip and corrupted checkpoint fails safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrator-'));
  const file = join(dir, 'nested', 'checkpoint.json');
  await saveJson(file, { schemaVersion: 2, done: 3 });
  assert.deepEqual(
    await loadJson(
      file,
      (v): v is { schemaVersion: number; done: number } => v?.schemaVersion === 2,
    ),
    { schemaVersion: 2, done: 3 },
  );
  await writeFile(file, '{broken');
  await assert.rejects(
    loadJson(file, (_v): _v is unknown => true),
    /Corrupted/,
  );
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

for (const [code, failures] of [
  ['EPERM', 1],
  ['EPERM', 4],
  ['EACCES', 1],
  ['EBUSY', 1],
] as const) {
  test(`atomic retries ${code} ${failures} time(s) and replaces canonical`, async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'storage-retry-')), 'state.json');
    await writeFile(file, 'old');
    let attempts = 0;
    const waited: number[] = [];
    await atomic(file, 'new', {
      rename: async (src, dst) => {
        attempts++;
        if (attempts <= failures) throw Object.assign(new Error(code), { code });
        await rename(src, dst);
      },
      wait: async (ms) => {
        waited.push(ms);
      },
    });
    assert.equal(attempts, failures + 1);
    assert.deepEqual(waited, [50, 100, 200, 400].slice(0, failures));
    assert.equal(await readFile(file, 'utf8'), 'new');
    assert.deepEqual(await orphanTemps(file), []);
  });
}

test('permanent rename failure retains canonical and complete, closed temp', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-fail-')), 'state.json');
  await writeFile(file, 'old');
  let failure: StorageError | undefined;
  try {
    await atomic(file, 'new', {
      rename: async () => {
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      },
      wait: async () => {},
      delays: [0, 0],
    });
  } catch (e) {
    failure = e as StorageError;
  }
  assert.ok(failure instanceof StorageError);
  assert.equal(failure.attempts, 3);
  assert.equal(await readFile(file, 'utf8'), 'old');
  assert.equal(await readFile(failure.tempFile, 'utf8'), 'new');
  assert.equal((await stat(failure.tempFile)).size, 3);
  // Windows denies this rename if our writer still holds its handle.
  const moved = `${failure.tempFile}.moved`;
  await rename(failure.tempFile, moved);
  assert.equal(await readFile(moved, 'utf8'), 'new');
});

test('two-phase replacement restores canonical when replacement still fails', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-bak-')), 'state.json');
  await writeFile(file, 'old');
  let calls = 0;
  await assert.rejects(
    atomic(file, 'new', {
      delays: [0, 0],
      wait: async () => {},
      rename: async (src, dst) => {
        calls++;
        if (calls <= 3 || calls === 5) throw Object.assign(new Error('locked'), { code: 'EPERM' });
        await rename(src, dst);
      },
    }),
    (e: any) => e instanceof StorageError,
  );
  assert.equal(await readFile(file, 'utf8'), 'old');
  assert.equal(calls, 6);
});

test('nontransient rename error is not retried', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-enoent-')), 'state.json');
  let attempts = 0;
  await assert.rejects(
    atomic(file, 'new', {
      rename: async () => {
        attempts++;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      wait: async () => {
        throw new Error('should not wait');
      },
    }),
    (e: any) => e instanceof StorageError && e.fsCode === 'ENOENT',
  );
  assert.equal(attempts, 1);
});

type Checkpoint = { schemaVersion: 2; source: string; processed: number };
const valid = (v: any): v is Checkpoint =>
  v?.schemaVersion === 2 && typeof v.source === 'string' && typeof v.processed === 'number';
const newer = (v: Checkpoint, old: Checkpoint | null) =>
  v.source === 'same' && (!old || (old.source === v.source && v.processed > old.processed));
const tempName = (file: string) => `${file}.00000000-0000-4000-8000-000000000001.tmp`;

test('restart loads canonical when no proven newer temp exists', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-restart-')), 'state.json');
  await saveJson(file, { schemaVersion: 2, source: 'same', processed: 3 });
  assert.equal((await recoverJson(file, valid, newer))?.processed, 3);
});

test('restart restores canonical from a valid orphan backup when canonical is absent', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-bak-restart-')), 'state.json');
  const backup = `${file}.00000000-0000-4000-8000-000000000001.bak`;
  await writeFile(backup, JSON.stringify({ schemaVersion: 2, source: 'same', processed: 7 }));
  assert.equal((await recoverJson(file, valid, newer))?.processed, 7);
  assert.equal(await orphanBackups(file).then((items) => items.length), 0);
});

test('valid newer orphan is promoted without removing unrelated temp', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-recovery-')), 'state.json');
  await saveJson(file, { schemaVersion: 2, source: 'same', processed: 3 });
  await writeFile(
    tempName(file),
    JSON.stringify({ schemaVersion: 2, source: 'same', processed: 4 }),
  );
  assert.equal((await recoverJson(file, valid, newer))?.processed, 4);
  assert.equal((await loadJson(file, valid))?.processed, 4);
  assert.deepEqual(await orphanTemps(file), []);
});

test('truncated and incompatible orphans are ignored and preserved', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'storage-ignore-')), 'state.json');
  await saveJson(file, { schemaVersion: 2, source: 'same', processed: 3 });
  const truncated = tempName(file);
  const incompatible = `${file}.00000000-0000-4000-8000-000000000002.tmp`;
  const wrongSchema = `${file}.00000000-0000-4000-8000-000000000003.tmp`;
  await writeFile(truncated, '{');
  await writeFile(
    incompatible,
    JSON.stringify({ schemaVersion: 2, source: 'different', processed: 99 }),
  );
  await writeFile(wrongSchema, JSON.stringify({ schemaVersion: 3, source: 'same', processed: 99 }));
  assert.equal((await recoverJson(file, valid, newer))?.processed, 3);
  assert.equal((await loadJson(file, valid))?.processed, 3);
  assert.deepEqual((await orphanTemps(file)).sort(), [truncated, incompatible, wrongSchema].sort());
});
