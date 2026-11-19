/** Shared fixture for the submit fail-fast journeys: a joined builder whose gate, static check and item check each leave a marker [V4,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliInProcess } from '../process.js';
import { settleSubmit } from './settle.js';
import { JOURNEY_MODE } from '../e2e.js';
import { builderRepo } from './gate.js';
import { commitAll } from './gate.js';
import { privateRepo } from './gate.js';
import { put } from './gate.js';
import { withBrief } from './gate.js';

export const MARK = path => `node test/mark.mjs ${path}`;
const GATE_FRONT_DOOR = fileURLToPath(new URL('../../../../../packages/gate/heavy.js', import.meta.url));

/** Run one public command in this process from a directory with the fixture's environment, in the child runner's result shape. */
export async function inProcess(box, cwd, ...args) {
  const result = await runCliInProcess(withBrief(...args), { cwd, env: box.env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * One submit from the builder's folder: answered in this process, or a real child under PULLBOARD_JOURNEY_MODE=process.
 * Why: a submit as its own node process costs a start-up per call; the static preflight and the gate job do not need one [C7,#10458].
 */
export async function submitStep(box, ...args) {
  return JOURNEY_MODE === 'process' ? box.run(...args) : inProcess(box, box.root, ...args);
}

/** A joined builder whose gate, static check and item check each leave their own marker when they run. */
export async function project(t, { staticFails = false, staticLint = false, staticWaitsForDoctrine = false, extra = {} } = {}) {
  const box = privateRepo(t);
  const markers = { gate: join(box.dir, 'gate.log'), staticCheck: join(box.dir, 'static.log'), item: join(box.dir, 'item.log'), doctrine: join(box.dir, 'doctrine.log') };
  put(box.root, 'pullboard.json', JSON.stringify({ gate: MARK(markers.gate), affectedTests: 'node --test', submitGate: 'landing',
    staticChecks: `${MARK(markers.staticCheck)} && ${staticLint ? 'node --experimental-vm-modules tools/style-check.js' : staticFails ? 'node test/static-problem.mjs' : staticWaitsForDoctrine ? `node test/wait-for.mjs ${markers.doctrine} ${join(box.dir, 'machine-home')}` : 'true'}`,
    shared: ['pullboard.json'], ...extra }));
  if (staticLint) {
    put(box.root, 'packages/gate/data/baselines/test-waits-baseline.json', '{}\n');
    put(box.root, 'tools/style-check.js', `import { readFileSync } from 'node:fs';
import { importStyleViolations } from ${JSON.stringify(GATE_FRONT_DOOR)};
const sources = ['test/style-bad.js'].map(file => ({ file, source: readFileSync(file, 'utf8') }));
const failures = importStyleViolations(sources);
for (const row of failures) console.error(row.file + ':' + row.line + ': one import binding per line (' + row.count + ' bindings)');
if (failures.length) process.exitCode = 1;
`);
  }
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/mark.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `ran ${Date.now()}\\n`);\n");
  // In the runner's gate job (a checkout under the machine's runner folder) it exits 0 only once the named file exists, so a static check that finishes there proves the doctrine rule was running beside it, whatever the load; the submit's own preflight, which runs no doctrine, passes at once.
  put(box.root, 'test/wait-for.mjs', "import { existsSync, realpathSync } from 'node:fs';\nif (!realpathSync(process.cwd()).startsWith(realpathSync(process.argv[3]))) process.exit(0);\nconst deadline = Date.now() + 60_000;\nwhile (!existsSync(process.argv[2])) {\n  if (Date.now() > deadline) { console.error('the doctrine rule never started beside the static check'); process.exit(1); }\n  await new Promise(resolve => setTimeout(resolve, 20));\n}\n");
  put(box.root, 'test/static-problem.mjs', "console.error('src/a.js:1: a static problem');\nprocess.exit(1);\n");
  put(box.root, 'DOCTRINE.md', `# Doctrine\n\n## D · Fail fast\n- D1 [approved, must] The fixture rule leaves a marker when it runs. | gate: check ${MARK(markers.doctrine)} | count: 0\n`);
  commitAll(box);
  const builder = builderRepo(box);
  assert.equal((await inProcess(builder, join(builder.dir, 'repo'), 'add', 'build', 'Fail fast fixture', '--criterion', 'the fixture change is submitted or refused', '--check', MARK(markers.item), '--wait')).code, 0);
  assert.equal((await inProcess(builder, builder.root, 'claim', '1')).code, 0);
  // Adding the item ran its check once to baseline it; only runs after this point count.
  for (const path of Object.values(markers)) rmSync(path, { force: true });
  return { box: builder, markers };
}

/** Submit item 1 and settle it: a pull submit returns queued at once, then the machine's local runner serves the gate job [P7,C7]. */
export async function submitAndSettle(t, box, ...extra) {
  const queued = await submitStep(box, 'submit', '1', '--json', '--no-next', '--infra', 'the fail-fast fixture', ...extra);
  assert.equal(queued.code, 0, JSON.stringify(queued));
  const settleBox = { repo: box.root, env: box.env, run: (cwd, ...args) => inProcess(box, cwd, ...args) };
  return settleSubmit(t, settleBox, JSON.parse(queued.out));
}
