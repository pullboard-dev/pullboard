/** A private committed repository with a CPU-only named test, for classifying checks without the CLI [C7,V4]. */
import { copyFixtureRunner } from '../copy.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runFixtureGit } from '../child.js';
import { fixtureProjectPolicy } from '../testkit.js';
import { RUNNER_COMMAND } from './lease.js';

/**
 * Create the repository the resource suite classifies checks in: the fixture runner, a CPU-only test and the policy files,
 * committed on main. It runs no `pullboard init`, so no CLI starts.
 *
 * @param {{ first: string, env: Record<string, string> }} box - A resource suite fixture; its first repository is used.
 * @returns {{ repo: string, base: string }} The repository root and its base commit.
 */
export function cpuCheckRepo(box) {
  const repo = box.first;
  runFixtureGit(['branch', '-M', 'main'], { cwd: repo, env: box.env });
  fixtureProjectPolicy(repo, { config: { gate: 'true', spec: 'SPEC.md', affectedTests: RUNNER_COMMAND, lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] },
    spec: '# CPU check fixture\n\n## G · Goals\n- G1 [approved, must] The fixture keeps its board. | gate: true\n' });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  copyFixtureRunner(resolve(import.meta.dirname, '../../../../..'), repo);
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/unrelated.test.js'), "import { test } from 'node:test'; test('unrelated test', () => {});\n");
  runFixtureGit(['add', '-A'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'fixture: initialize board'], { cwd: repo, env: box.env });
  const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo, env: box.env });
  writeFileSync(join(repo, 'test/cpu-check.test.js'), "import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\nconst mark = path => writeFileSync(path, 'started');\ntest('item check marker', () => mark('item-check-started'));\ntest('submit check marker', () => mark('submit-check-started'));\n");
  runFixtureGit(['add', 'test/cpu-check.test.js'], { cwd: repo, env: box.env });
  runFixtureGit(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Resource fixture', '-c', 'user.email=resource@example.invalid', 'commit', '-q', '-m', 'test: add CPU check'], { cwd: repo, env: box.env });
  return { repo, base };
}
