/** Actual private Submit cycles retain raw reds while repeated native pairs acquire quarantine authority [C7,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { flakyProject } from '../../../../../packages/git/tests/fixtures/flakes.js';
import { TITLE } from '../../../../../packages/git/tests/fixtures/flakes.js';
import { copyCommittedPackageFiles } from '../copy.js';
import { runFixtureGit } from '../child.js';
import { startFixtureLocalRunner } from '../runner/local-start.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { openBoard } from '../../../../lib/index.js';
import { flakeQuarantines } from '../../../../lib/index.js';
import { gateRuns } from '../../../../lib/index.js';
import * as store from '../../../../../packages/store/index.js';

// The worktree join inherits PULLBOARD_MODEL; without it the join refuses with MODEL_REQUIRED before any case runs.
process.env.PULLBOARD_MODEL ??= 'Test Model';

/** Build genuine private package source and an ordinary joined/claimed builder; no receipt is fabricated. */
export function fixture(t, deterministic = false, companion = false) {
  const box = flakyProject(t, { beforeInit: ({ root, git }) => {
    copyCommittedPackageFiles({ repo: root, git: (_root, ...args) => git(...args) }, resolve(import.meta.dirname, '../../../../..'));
    // The copied test-cell listing guards new root tests; the fixture's own controlled target is a journey it lists.
    const listing = join(root, 'packages/gate/data/tests/test-cells.json');
    const cells = JSON.parse(readFileSync(listing, 'utf8'));
    cells.journeys['test/alternating.test.mjs'] = 'drives the controlled intermittent assertion through the real submit gate';
    writeFileSync(listing, JSON.stringify(cells, null, 2) + '\n');
    return join(root, 'apps/cli/pullboard.js');
  } });
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { core: { owns: ['src/', 'test/', 'packages/controlled/'], specs: [] } };
  config.flakes = { rerun: true, quarantine: true };
  config.gate = 'node apps/cli/src/io/run/tests.js test/alternating.test.mjs';
  config.affectedTests = 'node apps/cli/src/io/run/tests.js';
  delete config.submitGate;
  delete config.submitDeferAbove;
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify(config) + '\n');
  // Remove only the consumer's generated cells plan; keep the shipped runtime manifest and modules intact.
  rmSync(join(box.root, 'packages/codemap/data/plan/cells.json'), { force: true });
  const behavior = join(box.root, 'packages/controlled/src/behavior.js');
  mkdirSync(dirname(behavior), { recursive: true });
  writeFileSync(behavior, '/** Return whether this controlled run should fail. */\nexport function shouldFail() { return false; }\n');
  writeFileSync(join(box.root, 'packages/controlled/index.js'), "export { shouldFail } from './src/behavior.js';\n");
  writeFileSync(join(box.root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';\nimport {appendFileSync,readFileSync} from 'node:fs';\nimport {test} from 'node:test';\nimport {shouldFail} from '../packages/controlled/index.js';\ntest(${JSON.stringify(TITLE)},()=>{appendFileSync(${JSON.stringify(box.counter)},'run\\n');const runs=readFileSync(${JSON.stringify(box.counter)},'utf8').trim().split('\\n').length;assert.equal(shouldFail(runs),false);});\n`);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: prepare controlled submit consumer');
  const made = box.cli('worktree', 'core');
  assert.equal(made.code, 0, JSON.stringify(made.document));
  const root = made.document.path;
  const cli = (...args) => box.cliAt(root, ...args);
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  if (!deterministic) writeFileSync(box.counter, 'run\n'); // Baseline executes a genuine pass; no legacy one-pair quarantine is seeded.
  // The baseline and every Submit gate are pulled jobs on the machine's loopback local runner; the scratch teardown stops it [P7,C7].
  startFixtureLocalRunner(box.env, box.root);
  const added = box.cli('add', 'core', 'Controlled native Submit', '--route', 'strong', '--criterion', 'Retain the actual initial failure.', '--brief', 'Files:\n- packages/controlled/src/behavior.js\n- test/alternating.test.mjs\nTest:\n- the controlled Submit receipt retains the real initial failure and paired pass', '--check', 'true', '--wait');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  assert.equal(added.document.item.item_check, 'true', JSON.stringify(added.document));
  const id = added.document.item.item_id;
  assert.equal(cli('claim', String(id)).code, 0);
  writeFileSync(join(root, 'packages/controlled/src/behavior.js'), `/** Return whether this controlled run should fail. */\nexport function shouldFail(runs) { return ${deterministic ? 'true' : 'runs % 2 === 1'}; }\n`);
  git('add', 'packages/controlled/src/behavior.js'); git('commit', '-q', '-m', 'chore: retain controlled proposal');
  if (companion) {
    const file = join(root, 'packages/controlled/src/companion.js');
    writeFileSync(file, 'export const companion = true;\n');
    git('add', 'packages/controlled/src/companion.js');
    const patch = git('diff', '--cached', '--binary') + '\n';
    git('restore', '--staged', 'packages/controlled/src/companion.js');
    rmSync(file);
    const patchFile = box.counter + '.patch';
    writeFileSync(patchFile, patch);
    const author = cli('whoami').document.id;
    const attached = box.cli('patch', 'attach', String(id), patchFile, '--key', 'controlled-companion', '--author', author, '--source', git('rev-parse', 'HEAD'));
    assert.equal(attached.code, 0, JSON.stringify(attached.document));
  }
  return { ...box, builder: { root, cli, git }, id };
}

/** Open this journey's real private fixture board, shared with its actual native CLI processes; the caller closes it. */
export function openFixtureBoard(box) {
  // @pullboard-board-file journey: actual Submit and native gate records persisted by this private CLI fixture
  return openBoard(join(box.root, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
}

/** Read only this journey's real fixture board, shared with its actual native CLI processes. */
export function snapshot(box) {
  const board = openFixtureBoard(box);
  try { return { quarantines: flakeQuarantines(board), jobs: board.db.prepare("SELECT * FROM job WHERE job_kind = 'flake-diagnose'").all(), steps: board.db.prepare("SELECT job_step_name AS name, substr(job_step_payload, 1, 1500) AS payload FROM job_step WHERE job_step_job LIKE 'flake-diagnose:%' ORDER BY job_step_seq").all(), runs: gateRuns(board), items: store.listItems(board, { all: true }), admissions: store.events(board).filter(event => ['claim', 'renew'].includes(event.event_kind)).map(event => JSON.parse(event.event_detail).submitAdmission).filter(Boolean) }; }
  finally { store.closeBoard(board); }
}

/** Begin another actual Submit admission with the controlled case failing on its initial body. */
export function submit(box) {
  writeFileSync(box.counter, '');
  return box.builder.cli('submit', String(box.id), '--infra', 'private controlled native fixture', '--no-next');
}

/**
 * Begin a Submit and await its pulled gate job's receipt: code 1 while the red keeps the item with its builder, 0 once
 * the board submitted it. Why: a pulled Submit returns as soon as its gate job is queued, so its verdict is the receipt's [P7,C7].
 */
export async function settledSubmit(box) {
  const queued = submit(box);
  assert.equal(queued.code, 0, JSON.stringify(queued.document));
  const shown = await whenRunnerSettles(box.env, () => {
    const document = box.cli('show', String(box.id)).document;
    // The job reads done once its receipt records; the board applies it just after, ending in a submit or a red measurement.
    const applied = document?.item_status === 'submitted' || document?.thread?.some(row => String(row.text ?? '').startsWith(`Gate job ${document.gateJob?.id} `) && / red at |passed but not submitted/u.test(row.text));
    return document?.gateJob?.step === 'done' && applied ? document : null;
  }, { deadlineMs: 180_000, what: `the gate for #${box.id}` });
  return { code: shown.item_status === 'submitted' ? 0 : 1, document: shown };
}
