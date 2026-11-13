/** Reuse one generated stress board per generator version, so only the first run on a runner pays the generation time [N26]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStressBoard } from './generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, '../../../../../../packages/store');

/** Every .js file under a directory, sorted, so the hash is stable. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(js|mjs|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Hash of the generator, the store it writes through, and the inputs: any change builds a fresh board. */
function cacheKey(inputs) {
  const hash = createHash('sha256').update(JSON.stringify(inputs));
  for (const file of [join(HERE, 'generate.mjs'), ...sources(STORE)]) hash.update(file.slice(HERE.length)).update(readFileSync(file));
  return hash.digest('hex').slice(0, 24);
}

/** Replace the cached workspace path with the copy's inside every string of a manifest. */
function repath(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map(entry => repath(entry, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repath(v, from, to)]));
  return value;
}

/**
 * The runner's own cache folder: a test run's TMPDIR is deleted with the run, so the cache lives beside the runner's other
 * caches under the real home (HOME is remapped inside test runs).
 */
export function stressCacheRoot() { return join(userInfo().homedir, '.pullboard-runner', 'cache', 'stress-boards'); }

/** Same result as generateStressBoard, but copied from the runner's cache; removeStressBoard cleans the copy. */
export function cachedStressBoard(inputs) {
  const cache = join(stressCacheRoot(), cacheKey(inputs));
  const marker = join(cache, 'complete');
  if (!existsSync(marker)) {
    const staging = join(stressCacheRoot(), `building-${process.pid}-${Date.now()}`);
    mkdirSync(staging, { recursive: true });
    const made = generateStressBoard({ ...inputs, parent: staging });
    writeFileSync(join(made.workspace, 'env.json'), JSON.stringify(made.env));
    writeFileSync(join(staging, 'complete'), `${made.workspace}\n`);
    try { renameSync(staging, cache); } catch { rmSync(staging, { recursive: true, force: true }); }
  }
  const built = readFileSync(marker, 'utf8').trim(), source = join(cache, basename(built));
  const workspace = join(tmpdir(), `pullboard-stress-${randomUUID()}`);
  cpSync(source, workspace, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(workspace, 'stress-board.json'), 'utf8'));
  const env = JSON.parse(readFileSync(join(workspace, 'env.json'), 'utf8'));
  rmSync(join(workspace, 'env.json'));
  return { ...repath(manifest, built, workspace), parent: tmpdir(), workspace, env: repath(env, built, workspace) };
}
