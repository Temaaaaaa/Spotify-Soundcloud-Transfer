import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Resolve once from this module, independently of the launcher's working directory.
export const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const loaded = config({ path: envFile });
if (loaded.error && (loaded.error as NodeJS.ErrnoException).code !== 'ENOENT') {
  throw new Error('Не удалось прочитать .env в корне проекта');
}
