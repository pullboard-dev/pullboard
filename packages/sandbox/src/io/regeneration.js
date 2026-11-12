/** Replay exact recorded board-tool intent on pinned main; every resulting head needs fresh proof [C7,V4,V6]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGitEnvironment } from '../../../git/index.js';
import { gitPath } from '../../../git/index.js';
import { invalidateGitFacts } from '../../../git/index.js';
import { recordedToolCommits } from '../../../git/index.js';
import { CELL_BASELINE_DESCRIPTOR } from '../../../codemap/index.js';
import { Refused } from '../../../kernel/index.js';
import { scratchFolder } from '../../../config/index.js';

/** Execute a bounded fixed executable, keeping complete diagnostics in the caller's private log. */
function execute(root, executable, args, log, { input, env = {} } = {}) {
  const result = spawnSync(executable, args, { cwd: root, env: { ...cleanGitEnvironment(), ...env }, input,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  log.push(`${executable} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status !== 0) throw new Error(`${executable} ${args[0] ?? ''} did not complete`);
  return (result.stdout ?? '').trim();
}

/** Re-run only canonical installed tools; custody is newly allocated outside the generated checkout. */
function replay(root, command, custody, log) {
  const script = command.tool === 'remove-shims' ? 'cells/scripts/plan.js' : 'cells/move.js';
  const args = command.tool === 'remove-shims' ? ['--remove-shims', command.cell, '--lane', command.lane]
    : ['--apply', command.from, command.to, command.frontDoor, command.purpose, custody,
      ...(command.keepExports === null ? [] : [`--keep-exports=${command.keepExports.join(',')}`])];
  execute(root, process.execPath, [fileURLToPath(new URL(`../../../codemap/src/io/${script}`, import.meta.url)), ...args], log);
}

/** Regenerate before submit's ordinary stages; null preserves the exact handwritten-conflict path. */
export function regenerateToolChange(root, source, main, { item }) {
  const recipes = recordedToolCommits(root, main, source);
  if (!recipes) return null;
  const directory = realpathSync(scratchFolder('pullboard-tool-regeneration-'));
  const checkout = join(directory, 'checkout');
  const log = [];
  const git = (cwd, args, options) => execute(cwd, 'git', ['--no-replace-objects', ...args], log, options);
  try {
    git(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout]);
    git(checkout, ['checkout', '--quiet', '--detach', main]);
    git(checkout, ['update-ref', 'refs/heads/main', main]);
    git(checkout, ['config', '--local', 'pullboard.trunk', 'refs/heads/main']);
    for (const [index, recipe] of recipes.entries()) {
      for (const [at, command] of recipe.commands.entries()) {
        const custody = join(directory, `custody-${index}-${at}`);
        mkdirSync(custody);
        replay(checkout, command, custody, log);
      }
      git(checkout, ['add', '-A', '--', '.']);
      const tree = git(checkout, ['write-tree']);
      const parent = git(checkout, ['rev-parse', 'HEAD']);
      const commit = git(checkout, ['commit-tree', tree, '-p', parent], {
        input: `${recipe.subject}\n\nPullboard-Item: #${item}\n`,
        env: { GIT_AUTHOR_NAME: recipe.author[0], GIT_AUTHOR_EMAIL: recipe.author[1],
          GIT_COMMITTER_NAME: recipe.author[0], GIT_COMMITTER_EMAIL: recipe.author[1] },
      });
      git(checkout, ['reset', '--quiet', '--mixed', commit]);
    }
    for (const script of ['cells/scripts/plan.js', ...(existsSync(join(checkout, CELL_BASELINE_DESCRIPTOR)) ? ['cell/scripts/lints.js'] : [])]) {
      execute(checkout, process.execPath, [fileURLToPath(new URL(`../../../codemap/src/io/${script}`, import.meta.url)), '--check'], log);
    }
    if (git(checkout, ['status', '--porcelain=v1']).length) throw new Error('cell checks changed their source');
    if (git(root, ['rev-parse', 'HEAD']) !== source || git(root, ['status', '--porcelain=v1']).length) {
      throw new Error('the original checkout changed while the tool regenerated');
    }
    const commit = git(checkout, ['rev-parse', 'HEAD']);
    const refs = git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/pullboard/tool-commands/']).split('\n').filter(Boolean);
    git(root, ['fetch', '--quiet', '--no-tags', checkout, 'HEAD', ...refs.map(ref => `${ref}:${ref}`)]);
    git(root, ['update-ref', `refs/pullboard/tool-regeneration/${source}`, source]);
    git(root, ['update-ref', `refs/pullboard/tool-regenerated/${commit}`, source]);
    // --keep refuses overlapping new user edits instead of discarding them like --hard.
    git(root, ['reset', '--keep', commit]);
    invalidateGitFacts();
    return { commit, from: source, main, commands: recipes.flatMap(recipe => recipe.commands) };
  } catch {
    const output = gitPath(root, `pullboard-tool-regeneration-${source}.log`);
    writeFileSync(output, log.join('\n'), { mode: 0o600 });
    throw new Refused('MERGE_CONFLICT', `the recorded board tool could not regenerate cleanly on main ${main.slice(0, 12)}; inspect ${output}; the original source is pinned or unchanged`,
      'repair the recorded tool or its inputs, run it again, commit and resubmit');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
