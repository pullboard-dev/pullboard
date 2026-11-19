/** Path-safe fixed-bound capsule installation shared by bootstrap and private copy controls [C7,P3]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Install a complete immutable module capsule without reading the job's stdin stream. */
export function installRunnerPackage(payload, expected, configuredRoot) {
  const home = process.env.HOME;
  if (!configuredRoot && (!home || !isAbsolute(home))) throw new Error('runner home must be absolute');
  const root = configuredRoot || join(home, '.pullboard-runner');
  const directory = join(root, 'runtime', expected);
  // A reuse capsule carries no bytes: the runtime installed under this digest must still hash to it exactly (#4140).
  if (payload === 'REUSE') {
    const installed = {};
    const walk = folder => {
      for (const name of fileSystemAdapter().list(join(directory, folder))) {
        const path = folder ? `${folder}/${name}` : name;
        if (fileSystemAdapter().stat(join(directory, path)).isDirectory()) walk(path);
        else installed[path] = fileSystemAdapter().readFile(join(directory, path), 'utf8');
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
  fileSystemAdapter().mkdir(root, { recursive: true, mode: 0o700 });
  fileSystemAdapter().chmod(root, 0o700);
  fileSystemAdapter().mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const build = fileSystemAdapter().mkdtemp(join(dirname(directory), `${expected}.build-`));
  try {
    for (const [name, source] of Object.entries(files)) {
      if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')
        || /[\\\u0000-\u001f\u007f]/u.test(name) || typeof source !== 'string') throw new Error(`unsafe capsule file ${name}`);
      fileSystemAdapter().mkdir(dirname(join(build, name)), { recursive: true, mode: 0o700 });
      fileSystemAdapter().writeFile(join(build, name), source, { mode: 0o600 });
    }
    try { fileSystemAdapter().rename(build, directory); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    if (Object.entries(files).some(([name, source]) => fileSystemAdapter().readFile(join(directory, name), 'utf8') !== source)) {
      throw new Error('trusted capsule does not match the request');
    }
  } finally { fileSystemAdapter().rm(build, { recursive: true, force: true }); }
}
