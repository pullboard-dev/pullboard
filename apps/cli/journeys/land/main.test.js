import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
import { assertLandingDoctrineCounts } from '../../tests/fixtures/land/doctrine.js';
import { events } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { mergeSubjects } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertSiblingConflictLanding } from '../../../../packages/store/tests/fixtures/collision.js';
/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

test('a landing records a falling doctrine count and holds a rising count [B3,R3,D1,D3]', () => {
  assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem });
});

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { order: [3, 1, 0, 2] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  const order = [3, 1, 0, 2].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [4, 2, 1, 3].map((n) => `feat(merge): land fixture ${n} [G1]`), 'each merge takes its item\'s type from the item\'s feat commit');
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip, 'real pre-push accepted the gated tip');
  assert.ok(relative(join(box.repo, '.git', 'pullboard'), result.batch.root).startsWith('landings/'));
  assert.notEqual(result.batch.root, box.repo);
  assert.deepEqual(calls(box).slice(start), [[]], 'one full batch gate; pre-push reads its exact green tree stamp');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  for (const [index, id] of order.entries()) assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'each train merge body is only its trailers, naming no lane branch');
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).id, result.batch.id);
  const eventCount = events(box).length;
  assert.deepEqual(json(box, box.repo, 'land').landed, []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [[]], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

test('a train merge body is only the item trailer even when the local Git config logs merges [B3,R3]', () => {
  const box = landProject();
  verifiedFour(box, { order: [0, 1, 2, 3] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'config', 'merge.log', 'true');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.equal(result.landed.length, 4);
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of result.landed.entries()) {
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'merge.log=true appends no shortlog to the body');
  }
});

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  assertSiblingConflictLanding({ landProject, itemWorktree, submitItem, acceptItem, json, file: FILES[0] });
});

/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */

function diagnosticOutput(batch) {
  const directory = dirname(batch.logPath);
  return readdirSync(directory).filter(file => file.startsWith('diagnostic-') && file.endsWith('.log'))
    .map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
}

test('land diagnostics inherit their browser gate lease [C7]', () => {
  const box = landProject();
  const marker = join(box.dir, 'land-diagnostic-lease.json');
  const inspector = join(box.dir, 'inspect-land-diagnostic-lease.mjs');
  const resourcesUrl = new URL('../../../../packages/resources/index.js', import.meta.url).href;
  writeFileSync(inspector, [
    "import { writeFileSync } from 'node:fs';",
    `import { inheritedGateSlot } from ${JSON.stringify(resourcesUrl)};`,
    "const lease = inheritedGateSlot({ root: process.cwd(), browser: true });",
    "if (!lease?.browser) throw new Error('focused diagnosis did not inherit its browser lease');",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ file: process.argv[2], held: process.env.PULLBOARD_GATE_SLOT_HELD ?? '', pool: process.env.PULLBOARD_GATE_SLOT_POOL ?? '', token: process.env.PULLBOARD_GATE_SLOT_TOKEN ?? '', browser: process.env.PULLBOARD_BROWSER_SLOT_HELD ?? '', inheritedBrowser: lease.browser }));`,
  ].join('\n'));

  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = `node ${JSON.stringify(inspector)}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  const configCommit = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: inspect landing diagnostic lease');
  assert.equal(configCommit.status, 0, configCommit.stderr);
  const configPush = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(configPush.status, 0, configPush.stderr);

  const entry = itemWorktree(box, 1, FILES[0]);
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    submitItem(box, entry, 'RED\n');
    acceptItem(box, entry);
  } finally {
    delete box.env.LAND_SUPPRESS_RED;
  }
  const result = json(box, box.repo, 'land');
  assert.equal(result.batch.state, 'flaky', `the full gate is red while its isolated diagnosis passes: ${diagnosticOutput(result.batch)}`);
  assert.deepEqual(result.flakes.map(({ test: file }) => file), [FILES[0]]);
  const inherited = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(inherited.file, FILES[0]);
  assert.equal(inherited.held, '1');
  assert.ok(inherited.pool, 'the child names the machine resource pool');
  assert.ok(inherited.token, 'the child names the live gate lease token');
  assert.equal(inherited.browser, '1');
  assert.equal(inherited.inheritedBrowser, true);
});
