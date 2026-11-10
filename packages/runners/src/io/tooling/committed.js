/** Export runner controllers from immutable Git objects, independently of checkout edits [O5,C7]. */
import { gitSpawnSync } from '../../../../git/index.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Refused } from '../../../../kernel/index.js';
import { dropStagingFolder } from '../keyed.js';
import { placeKeyedFolder } from '../keyed.js';
import { sweepKeyedFolders } from '../keyed.js';
import { touchKeyedFolder } from '../keyed.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MANIFEST = '.pullboard-runner-source.json';

/** Read literal Git objects without project-selected repositories, replacement objects or filters. */
function toolingGit(root, args, binary = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = gitSpawnSync(['--no-replace-objects', ...args], { cwd: root, env,
    encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Refused('RUNNER_TOOLING_FILES', 'selected runner tooling Git objects are unavailable; restore the committed tooling installation');
  return binary ? result.stdout : result.stdout.trim();
}

/** Retain exact Git provenance for an owned archive without treating its metadata as byte authority. */
export function archivedToolingSource(root) {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) return null;
  let source;
  try { source = JSON.parse(readFileSync(file, 'utf8')); } catch { source = null; }
  if (!source || Object.keys(source).sort().join(',') !== 'commit,root,tree,version' || source.version !== 1
    || typeof source.root !== 'string' || !isAbsolute(source.root) || !OID.test(source.commit ?? '') || !OID.test(source.tree ?? '')
    || toolingGit(source.root, ['rev-parse', `${source.commit}^{tree}`]) !== source.tree) {
    throw new Refused('RUNNER_TOOLING_CHANGED', 'archived runner tooling provenance is invalid; restart from the committed installation');
  }
  return source;
}

/** The prefix of every committed controller folder; a shared one adds its 32-hex key. */
const PREFIX = 'pullboard-committed-runner-';
/** How long an unused shared controller folder stays before a new export removes it; no gate dispatch lives this long. */
const SHARED_KEEP_MS = 6 * 3_600_000;

/**
 * The shared export of one repository's commit when it is complete and this user's alone, else null. Why the checks: a
 * folder another user could write might hold a controller that is not this commit's, so it is never reused.
 */
function sharedExport(directory, root, commit, tree) {
  try {
    const state = statSync(directory);
    if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o022) !== 0) return null;
    const source = JSON.parse(readFileSync(join(directory, MANIFEST), 'utf8'));
    if (source.version !== 1 || source.root !== resolve(root) || source.commit !== commit || source.tree !== tree
      || !existsSync(join(directory, 'apps/runner/src/io/controller.js'))) return null;
    touchKeyedFolder(directory);
    return directory;
  } catch { return null; }
}

/** Remove shared controller folders unused for SHARED_KEEP_MS, except `keep`. */
function pruneSharedExports(keep) {
  const shared = new RegExp(`^${PREFIX}[a-f0-9]{32}$`, 'u');
  sweepKeyedFolders(tmpdir(), { matches: name => shared.test(name), keep, maxAgeMs: SHARED_KEEP_MS });
}

/**
 * Make one owned git-archive installation; callers drain their controller before removing it. With `shared`, the
 * export of a commit is made once and reused by every later dispatch of that commit, whose cleanup leaves it in place.
 * Why: every runner dispatch exported and unpacked the whole tooling tree twice, about a second each when idle and far
 * more at load, before it could connect (9 Nov) [C7]. A commit names its tree, so the export never changes.
 *
 * @param {string} root
 * @param {{ shared?: boolean }} [options]
 */
export function committedRunnerController(root, { shared = false } = {}) {
  if (!existsSync(join(root, '.git'))) return null;
  const commit = toolingGit(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = toolingGit(root, ['rev-parse', `${commit}^{tree}`]);
  if (!OID.test(commit) || !OID.test(tree) || toolingGit(root, ['rev-parse', '--show-toplevel']) !== resolve(root)) {
    throw new Refused('RUNNER_TOOLING_FILES', 'runner tooling must name its exact committed repository');
  }
  const target = shared ? join(tmpdir(), PREFIX + createHash('sha256').update(`${resolve(root)}\0${commit}`).digest('hex').slice(0, 32)) : null;
  const reused = target && sharedExport(target, root, commit, tree);
  if (reused) return { root: reused, entry: join(reused, 'apps/runner/src/io/controller.js'), commit, tree, cleanup() {} };
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    // A repository's local attributes and CRLF filters can alter git-archive bytes too. An
    // isolated object view overrides every conversion without touching the user's Git settings.
    const objects = toolingGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
    const metadata = join(directory, '.objects');
    toolingGit(root, ['init', '--quiet', '--bare', metadata]);
    writeFileSync(join(metadata, 'objects/info/alternates'), `${objects}\n`, { flag: 'wx' });
    mkdirSync(join(metadata, 'info'), { recursive: true });
    writeFileSync(join(metadata, 'info/attributes'), '* -text -filter -ident -export-subst -export-ignore\n', { flag: 'wx' });
    const archive = toolingGit(root, ['--git-dir', metadata, '-c', 'core.autocrlf=false',
      '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', commit], true);
    const unpacked = spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive, encoding: 'utf8' });
    if (unpacked.status !== 0 || !existsSync(join(directory, 'apps/runner/src/io/controller.js'))) {
      throw new Refused('RUNNER_TOOLING_FILES', 'the selected Git archive has no runner controller; restore committed tooling');
    }
    writeFileSync(join(directory, MANIFEST), JSON.stringify({ version: 1, root: resolve(root), commit, tree }), { flag: 'wx', mode: 0o400 });
    if (target) {
      // Renamed into place whole, so no dispatch sees half an export; a concurrent export that won the rename is the
      // same commit. A folder in the way that is not this commit's own leaves this export private, as before.
      const moved = placeKeyedFolder(directory, target);
      const placed = sharedExport(target, root, commit, tree);
      if (placed) {
        if (!moved) dropStagingFolder(directory);
        pruneSharedExports(placed);
        return { root: placed, entry: join(placed, 'apps/runner/src/io/controller.js'), commit, tree, cleanup() {} };
      }
      if (moved) throw new Refused('RUNNER_TOOLING_FILES', 'the shared runner tooling export could not be read back; retry from the committed installation');
    }
    return { root: directory, entry: join(directory, 'apps/runner/src/io/controller.js'), commit, tree,
      cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
