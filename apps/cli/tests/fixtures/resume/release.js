/** Shared release fixture for the resume journeys: an isolated board whose CLI is a copy of the production CLI at a chosen version [N19,N32]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../copy.js';
import { journeyCall } from '../e2e.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../../packages/kernel/index.js';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../child.js';
import { runCliInProcess } from '../process.js';

export const PRIVATE_CHANGELOG = `# Changelog\n\n## [0.8.7] - 2026-10-12\n\n### A new session\n\nThe latest headline paragraph.\n\n### Added\n\n- The detailed release list is not part of the resume.\n\n## [0.8.6] - 2026-10-11\n\n### See the flow\n\nThe middle headline paragraph.\n\n### Fixed\n\n- A detailed fix.\n\n## [0.8.5] - 2026-10-10\n\n### A prettier board\n\nThe previous release.\n`;
export const LONG_CHANGELOG = `# Changelog\n\n## [0.8.9] - 2026-10-14\n\n### Nine\n\nNine paragraph.\n\n## [0.8.8] - 2026-10-13\n\n### Eight\n\nEight paragraph.\n\n## [0.8.7] - 2026-10-12\n\n### Seven\n\nSeven paragraph.\n\n## [0.8.6] - 2026-10-11\n\n### Six\n\nSix paragraph.\n\n## [0.8.5] - 2026-10-10\n\n### Five\n\nFive paragraph.\n\n## [0.8.4] - 2026-10-09\n\n### Added\n\nThis category heading is not a release headline.\n`;

/** Copied production CLIs by release version and changelog; each is read-only, so every case of a run shares one. */
const copies = new Map();
process.on('exit', () => { for (const dir of copies.values()) rmSync(dir, { recursive: true, force: true }); });

/** The copy of the production CLI at a release version, made once per run: the file-by-file copy dominated each case. */
function releaseCli(version, changelog) {
  const key = JSON.stringify([version, changelog]);
  if (copies.has(key)) return copies.get(key);
  const cli = privateFixtureFiles('pullboard-resume-cli-').root;
  copies.set(key, cli);
  copyPackageFiles(join(import.meta.dirname, '../../../../..'), cli);
  mkdirSync(join(cli, 'bin'), { recursive: true }); // the shim folder is the fixture's own; the shipped CLI lives in apps/cli
  symlinkSync(join(cli, 'apps/cli/pullboard.js'), join(cli, 'bin/pullboard'));
  const packageData = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../package.json'), 'utf8'));
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ ...packageData, version }));
  writeFileSync(join(cli, 'CHANGELOG.md'), changelog);
  return cli;
}

/** Build an isolated copy of the production CLI at a chosen release version. */
export function releaseFixture(t, { previous = null, version = '0.8.7', changelog = PRIVATE_CHANGELOG, freshSetup = false, historyBeforeInit = false } = {}) {
  const root = privateFixtureFiles('pullboard-resume-release-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  if (!freshSetup) writeFileSync(join(repo, 'SPEC.md'), '# Release fixture\n\n## N · Resume\n- N19 [approved, must] Resume announces released headlines once per checkout. | gate: review\n');
  symlinkSync(releaseCli(version, changelog), cli);
  const env = { ...process.env, PATH: `${join(cli, 'bin')}:${process.env.PATH}`, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  delete env.PULLBOARD_RELAY_TOKEN;
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  if (historyBeforeInit) {
    writeFileSync(join(repo, 'README.md'), '# Existing repository\n');
    runFixtureGit(['add', 'README.md'], { cwd: repo, env });
    runFixtureGit(['commit', '-q', '-m', 'chore: create existing repository'], { cwd: repo, env });
  }
  /** Run the copied production CLI in the selected real checkout. */
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [join(cli, 'apps/cli/pullboard.js'), ...args], { cwd, env, encoding: 'utf8' });
  /** The same call answered by the production dispatcher in this process, for cases that do not read the copied CLI's version or changelog. */
  // PULLBOARD_JOURNEY_MODE=process answers the same call as a real process of the copied CLI, so the gate's parity check can compare the two (#8276).
  const runLocal = (cwd, ...args) => journeyCall({ dir: root, env, cwd, args, inProcess: () => runCliInProcess(args, { cwd, env }), real: () => run(cwd, ...args) });
  /** Run Git with this fixture's private identity and configuration. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const initialized = run(repo, 'init');
  assert.equal(initialized.status, 0, initialized.failure || initialized.stderr || initialized.stdout);
  if (previous) {
    const record = join(repo, '.git', 'pullboard-checkout', 'resume-version');
    mkdirSync(join(repo, '.git', 'pullboard-checkout'), { recursive: true });
    writeFileSync(record, `${previous}\n`);
  }
  return { root, repo, run, runLocal, git, env };
}


/**
 * Rewrite the copied root's Claude settings file so it names the new root and none of the template root's [C7,#8997].
 * Why: init writes the root's machine-home path into the sandbox write list, so a root copied from a cached template would otherwise point at the template.
 *
 * @param {string} templateRoot the fixture root the copy was made from
 * @param {string} newRoot the copy
 */
export function relocateClaudeSettings(templateRoot, newRoot) {
  const file = join(newRoot, 'repo', '.claude', 'settings.json');
  let text = readFileSync(file, 'utf8');
  for (const spelling of new Set([templateRoot, realpathSync(templateRoot)])) text = text.split(spelling).join(newRoot);
  writeFileSync(file, text);
}
