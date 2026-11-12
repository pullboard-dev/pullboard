/** A real committed tooling move retries one native submit and records only infrastructure [V4,C7,P3]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { committedToolingSnapshot } from '../../tests/fixtures/runner/tooling.js';
import { cleanupToolingSnapshots } from '../../tests/fixtures/runner/tooling.js';
import { openBoard } from '../../../lib/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { claimProgress } from '../../../../packages/items/index.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
after(cleanupToolingSnapshots);

/** Demand a genuine private native command result. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Give this case a joined item, a clean source commit and a private mutable CLI generation. */
function fixture(t, mode) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = json(box, box.repo, 'add', 'web', 'Tooling retry fixture', '--criterion', 'The committed page is submitted.', '--check', 'true');
  const id = added.item.item_id;
  json(box, box.web, 'claim', String(id));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'built\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build retry fixture [G1]');
  const tooling = join(box.dir, 'tooling');
  cpSync(committedToolingSnapshot(ROOT, box.env), tooling, { recursive: true, filter: path => basename(path) !== '.git' });
  const marker = join(box.dir, 'tooling-moves.log');
  const transition = join(box.dir, 'tooling-transition.mjs');
  const parser = join(tooling, 'packages/runners/src/io/module/parser.js');
  writeFileSync(transition, `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertRunnerModuleParserCurrent } from ${JSON.stringify(pathToFileURL(parser).href)};
/** Land a real private compiler change before asking the loaded compiler to validate itself. */
export function moveTooling() {
  const count = existsSync(${JSON.stringify(marker)}) ? readFileSync(${JSON.stringify(marker)}, 'utf8').trim().split('\\n').length : 0;
  if (${JSON.stringify(mode)} === 'once' && count) return;
  appendFileSync(${JSON.stringify(marker)}, 'move\\n');
  appendFileSync(${JSON.stringify(parser)}, '\\n// private tooling generation ' + (count + 1) + '\\n');
  if (${JSON.stringify(mode)} !== 'dirty') {
    execFileSync('git', ['add', 'packages/runners/src/io/module/parser.js'], { cwd: ${JSON.stringify(tooling)}, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'test: land private tooling generation'], { cwd: ${JSON.stringify(tooling)}, stdio: 'pipe' });
  }
  assertRunnerModuleParserCurrent();
}
`);
  const submitFile = join(tooling, 'apps/cli/src/io/commands/submit.js');
  const source = readFileSync(submitFile, 'utf8');
  const anchor = '  ctx.submitAttempt = { agentId: held.item_owner, digest: held.item_frozen_digest };';
  assert.ok(source.includes(anchor), 'the fixture injects at the real owned submit boundary');
  writeFileSync(submitFile, source.replace(anchor, `${anchor}\n  (await import(${JSON.stringify(pathToFileURL(transition).href)})).moveTooling();`));
  box.git(tooling, 'init', '-q', '-b', 'main');
  box.git(tooling, 'add', '-A');
  box.git(tooling, 'commit', '-q', '-m', 'test: commit private retry CLI');
  return { ...box, id, tooling, marker };
}

/** Inspect only this private CLI fixture's native facts and failed-submit count. */
function observation(box) {
  // @pullboard-board-file persistence: private native CLI fixture, observe its durable infrastructure facts and progress.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = getItem(board, box.id);
    const details = events(board, { itemId: box.id }).map(event => ({ kind: event.event_kind, ...JSON.parse(event.event_detail) }));
    return { status: item.item_status, failures: claimProgress(board, item, Date.now()).failures,
      outcomes: details.filter(detail => detail.submitOutcome),
      infrastructure: details.filter(detail => detail.kind === 'note' && detail.text?.startsWith('Submit infrastructure refusal [RUNNER_TOOLING_CHANGED]')) };
  } finally { closeBoard(board); }
}

/** Start the copied production entry with the original arguments and the private project's seat identity. */
function submit(box) {
  return runFixtureChildAsync(process.execPath, [join(box.tooling, 'apps/cli/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
}

test('a tooling landing during submit reloads the committed CLI once and counts zero failures [V4,C7,P3]', async t => {
  const box = fixture(t, 'once');
  const result = await submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).id, box.id, 'one final JSON document belongs to the fresh successful submit');
  assert.equal(readFileSync(box.marker, 'utf8'), 'move\n', 'one real tooling landing occurred');
  assert.equal((result.stderr.match(/retrying submit once from committed CLI/gu) ?? []).length, 1);
  const recorded = observation(box);
  assert.equal(recorded.status, 'submitted');
  assert.equal(recorded.failures, 0);
  assert.equal(recorded.outcomes.length, 0, 'infrastructure never records a countable failed-submit outcome');
  assert.equal(recorded.infrastructure.length, 1, 'the original refusal remains a native infrastructure observation');
});

test('a second tooling landing returns the genuine refusal without a third process or failure count [V4,C7,P3]', async t => {
  const box = fixture(t, 'always');
  const result = await submit(box);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'RUNNER_TOOLING_CHANGED');
  assert.equal(readFileSync(box.marker, 'utf8'), 'move\nmove\n', 'only the original and one fresh attempt ran');
  assert.equal((result.stderr.match(/retrying submit once from committed CLI/gu) ?? []).length, 1);
  const recorded = observation(box);
  assert.equal(recorded.status, 'claimed');
  assert.equal(recorded.failures, 0);
  assert.equal(recorded.infrastructure.length, 2);
});

test('an uncommitted tooling edit refuses without automatic execution or a failed-submit count [V4,C7,P3]', async t => {
  const box = fixture(t, 'dirty');
  const result = await submit(box);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'RUNNER_TOOLING_CHANGED');
  assert.equal(readFileSync(box.marker, 'utf8'), 'move\n');
  assert.equal((result.stderr.match(/retrying submit once from committed CLI/gu) ?? []).length, 0);
  const recorded = observation(box);
  assert.equal(recorded.status, 'claimed');
  assert.equal(recorded.failures, 0);
  assert.equal(recorded.infrastructure.length, 1);
});
