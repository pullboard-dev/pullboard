/** Path-safe fixed-bound capsule installation shared by bootstrap and private copy controls [C7,P3]. */
import { environmentAdapter } from '../../../../env/index.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Install a complete immutable module capsule without reading the job's stdin stream. */
export function installRunnerPackage(payload, expected, configuredRoot) {
  const home = environmentAdapter().get('HOME');
  if (!configuredRoot && (!home || !isAbsolute(home))) throw new Error('runner home must be absolute');
  const root = configuredRoot || join(home, '.pullboard-runner');
  const directory = join(root, 'runtime', expected);
  // A reuse capsule carries no bytes: the runtime installed under this digest must still hash to it exactly (#4140).
  if (payload === 'REUSE') {
    const installed = {};
    const walk = folder => {
      for (const name of readdirSync(join(directory, folder))) {
        const path = folder ? `${folder}/${name}` : name;
        if (statSync(join(directory, path)).isDirectory()) walk(path);
        else installed[path] = readFileSync(join(directory, path), 'utf8');
      }
    };
    try { walk(''); } catch { throw new Error('PULLBOARD_RUNNER_RUNTIME_MISSING'); }
    const ordered = Object.fromEntries(Object.entries(installed).sort(([a], [b]) => a.localeCompare(b)));
    if (createHash('sha256').update(JSON.stringify(ordered)).digest('hex') !== expected) throw new Error('PULLBOARD_RUNNER_RUNTIME_MISSING');
    return;
  }
  // 8 MiB of sources under the 4 MiB stdin capsule bound; the worker code passed 1 MiB on 9 Nov (#3884).
  const bytes = gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: 8 * 1_048_576 });
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('invalid capsule identity');
  const files = JSON.parse(bytes);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const build = mkdtempSync(join(dirname(directory), `${expected}.build-`));
  try {
    for (const [name, source] of Object.entries(files)) {
      if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
        || /[\\\u0000-\u001f\u007f]/u.test(name) || typeof source !== 'string') throw new Error(`unsafe capsule file ${name}`);
      mkdirSync(dirname(join(build, name)), { recursive: true, mode: 0o700 });
      writeFileSync(join(build, name), source, { mode: 0o600 });
    }
    try { renameSync(build, directory); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    if (Object.entries(files).some(([name, source]) => readFileSync(join(directory, name), 'utf8') !== source)) {
      throw new Error('trusted capsule does not match the request');
    }
  } finally { rmSync(build, { recursive: true, force: true }); }
}
