import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function probe(withEnv: boolean) {
  const base = path.join(root, 'data', 'environment-tests');
  await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(path.join(base, 'case-'));
  await mkdir(path.join(fixture, 'server'));
  await copyFile(
    path.join(root, 'server', 'environment.ts'),
    path.join(fixture, 'server', 'environment.ts'),
  );
  if (withEnv) {
    await writeFile(
      path.join(fixture, '.env'),
      'SPOTIFY_CLIENT_ID=test-id\nSPOTIFY_CLIENT_SECRET=test-secret\nPORT=3219\n',
    );
  }
  const configPath = path.join(fixture, 'server', 'configuration.ts');
  await writeFile(
    configPath,
    `import { envFile } from './environment.js';
export const result = { envFile, idLoaded: !!process.env.SPOTIFY_CLIENT_ID, secretLoaded: !!process.env.SPOTIFY_CLIENT_SECRET, port: Number(process.env.PORT || 3000) };`,
  );
  const childEnv = { ...process.env };
  for (const key of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'PORT']) {
    delete childEnv[key];
  }
  const script = `const {result}=await import(${JSON.stringify(pathToFileURL(configPath).href)}); console.log(JSON.stringify(result));`;
  const child = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { cwd: tmpdir(), env: childEnv, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(child.status, 0, 'Isolated environment probe must exit successfully');
  return { result: JSON.parse(child.stdout), expected: path.join(fixture, '.env') };
}
test('dotenv loads the project root before import-time configuration, from a different cwd', async () => {
  const { result, expected } = await probe(true);
  assert.deepEqual(result, { envFile: expected, idLoaded: true, secretLoaded: true, port: 3219 });
});
test('missing .env still permits unauthenticated startup', async () => {
  const { result, expected } = await probe(false);
  assert.deepEqual(result, { envFile: expected, idLoaded: false, secretLoaded: false, port: 3000 });
});
