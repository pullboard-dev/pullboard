/** Install the trunk guard into a trunk remote, and keep the board's landing key that signs land jobs' permits (#5848) [B3,P7]. */
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit } from '../main.js';

const MARK = '// pullboard trunk guard';
const HOME = 'pullboard-trunk-guard';
const KEY_FILE = join('pullboard', 'landing.key');

/**
 * Install the trunk guard into a trunk remote repository on this machine: copy the guard and its permit logic, write
 * its pre-receive hook, and set the landing key, the trunk ref and receive.advertisePushOptions, without which git
 * refuses push options. Refuses to replace a pre-receive hook it did not write.
 *
 * @param {string} gitDir - The remote repository's git directory (a bare repository, or a checkout's .git).
 * @param {{ key: string, trunk?: string }} settings - key: the board's landing key (ensureLandingGuardKey).
 * @returns {{ hook: string }}
 */
export function installTrunkGuard(gitDir, { key, trunk = 'refs/heads/main' }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('the trunk guard needs the board\'s landing key; create it with ensureLandingGuardKey');
  const listed = tryGit(gitDir, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (listed.status !== 0) throw new Error(`${gitDir} is not a git repository: ${listed.stderr.slice(0, 200)}`);
  const hooks = listed.stdout, hook = join(hooks, 'pre-receive');
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(MARK)) throw new Error(`${hook} exists and is not Pullboard's trunk guard; merge it by hand`);
  // A hook's first line cannot carry a space, so node must sit on a path without one.
  if (/\s/u.test(process.execPath)) throw new Error(`node's path ${process.execPath} has a space; install node on a path without one`);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const [from, to] of [[join(here, 'guard.js'), join('src/io/trunk/guard.js')], [join(here, '..', '..', 'logic', 'permit.js'), join('src/logic/permit.js')]]) {
    mkdirSync(dirname(join(hooks, HOME, to)), { recursive: true });
    copyFileSync(from, join(hooks, HOME, to));
  }
  writeFileSync(join(hooks, HOME, 'package.json'), '{ "type": "module" }\n');
  // The hook is node itself; a dynamic import reads the same as CommonJS or as a module, whichever scope the hooks folder is in.
  writeFileSync(hook, `#!${process.execPath}\n${MARK}\nimport('node:path').then(path => import('node:url').then(url => import(url.pathToFileURL(path.join(path.dirname(process.argv[1]), '${HOME}', 'src/io/trunk/guard.js')).href))).then(guard => guard.trunkGuardMain());\n`);
  chmodSync(hook, 0o755);
  for (const [name, value] of [['receive.advertisePushOptions', 'true'], ['pullboard.landingKey', key], ['pullboard.trunk', trunk]]) {
    const set = tryGit(gitDir, ['config', name, value]);
    if (set.status !== 0) throw new Error(`could not set ${name}: ${set.stderr.slice(0, 200)}`);
  }
  return { hook };
}

/** The board's landing key file in the board host repository's git directory, or null outside a repository. */
function keyFile(root) {
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common.status === 0 ? join(common.stdout, KEY_FILE) : null;
}

/** The board's landing key, or null when the board has none: then land jobs carry no permit. */
export function landingGuardKey(root) {
  const file = root ? keyFile(root) : null;
  return file && existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

/** The board's landing key, created once: 32 random bytes as hex, readable by its owner only. */
export function ensureLandingGuardKey(root) {
  const existing = landingGuardKey(root);
  if (existing) return existing;
  const file = keyFile(root);
  if (!file) throw new Error(`${root} is not a git repository`);
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}
