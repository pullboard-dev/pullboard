/** Path-safe fixed-bound capsule installation shared by bootstrap and private copy controls [C7,P3]. */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Install a complete immutable module capsule without reading the job's stdin stream. */
export function installRunnerPackage(payload, expected, configuredRoot) {
  const bytes = gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: 1_048_576 });
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('invalid capsule identity');
  const files = JSON.parse(bytes);
  const home = process.env.HOME;
  if (!configuredRoot && (!home || !isAbsolute(home))) throw new Error('runner home must be absolute');
  const root = configuredRoot || join(home, '.pullboard-runner');
  const directory = join(root, 'runtime', expected);
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
