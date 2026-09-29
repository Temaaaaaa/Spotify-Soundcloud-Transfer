import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('consumer screen has six steps, a native confirmation dialog and closed advanced details', async () => {
  const source = await readFile('src/App.tsx', 'utf8');
  assert.match(source, /const steps = \[[^\]]+\]/);
  for (const label of [
    'Подключение',
    'Сканирование',
    'Совпадения',
    'Подготовка',
    'Перенос',
    'Готово',
  ])
    assert.match(source, new RegExp(`'${label}'`));
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /<details className="advanced">/);
  assert.doesNotMatch(
    source,
    /<input\b|PLAYLISTS \$\{|ACCEPT DUPLICATE LOSS|TEST LIKE ORDER|migrationPlanId/,
  );
});
