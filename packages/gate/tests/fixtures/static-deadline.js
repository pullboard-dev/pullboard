/** Runs changedStaticFailures on no files in a fixture child that has the flag the static checks need, so a cell test never launches a node child itself [C7]. */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './child.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CHECKER_SOURCE = fileURLToPath(new URL('../../src/io/changed/static.js', import.meta.url));
const REGISTRY_SOURCE = fileURLToPath(new URL('../../src/io/static/check/registry.js', import.meta.url));

/** The result of changedStaticFailures with a probe check added, the probe's run log, and the registry's check names; deadline -1 is already passed, 1 is far off. */
export function deadlineRun(options) {
  const code = [
    `import { changedStaticFailures } from ${JSON.stringify(pathToFileURL(CHECKER_SOURCE).href)};`,
    `import { STATIC_CHECKS } from ${JSON.stringify(pathToFileURL(REGISTRY_SOURCE).href)};`,
    'const ran = [];',
    "const probe = { name: 'deadline-probe', run: () => { ran.push('probe'); return []; } };",
    `const options = ${JSON.stringify(options)};`,
    'if (options.deadline === -1) options.deadline = Date.now() - 1;',
    'if (options.deadline === 1) options.deadline = Date.now() + 600000;',
    `const result = changedStaticFailures(${JSON.stringify(ROOT)}, [], { ...options, also: [probe] });`,
    'process.stdout.write(JSON.stringify({ result, ran, names: STATIC_CHECKS.map(check => check.name) }));'].join('\n');
  const run = runFixtureChild(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}
