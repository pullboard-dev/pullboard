/** Export runner controllers from immutable Git objects, independently of checkout edits [O5,C7]. */
import { gitSpawnSync } from '../../../git/index.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Refused } from '../../../kernel/index.js';

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

/** Make one owned git-archive installation; callers drain their controller before removing it. */
export function committedRunnerController(root) {
  if (!existsSync(join(root, '.git'))) return null;
  const commit = toolingGit(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = toolingGit(root, ['rev-parse', `${commit}^{tree}`]);
  if (!OID.test(commit) || !OID.test(tree) || toolingGit(root, ['rev-parse', '--show-toplevel']) !== resolve(root)) {
    throw new Refused('RUNNER_TOOLING_FILES', 'runner tooling must name its exact committed repository');
  }
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-committed-runner-'));
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
    if (unpacked.status !== 0 || !existsSync(join(directory, 'bin/runner-controller.js'))) {
      throw new Refused('RUNNER_TOOLING_FILES', 'the selected Git archive has no runner controller; restore committed tooling');
    }
    writeFileSync(join(directory, MANIFEST), JSON.stringify({ version: 1, root: resolve(root), commit, tree }), { flag: 'wx', mode: 0o400 });
    return { root: directory, entry: join(directory, 'bin/runner-controller.js'), commit, tree,
      cleanup() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
