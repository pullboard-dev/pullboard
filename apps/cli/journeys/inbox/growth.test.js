/** No command's default text grows past its size on merge-base main [C7,N26]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { createBudgetMeasure } from '../../tests/fixtures/budget-measure.js';
import { observeProcesses, processObservation, renderAgents } from '../../tests/fixtures/budget-process-sample.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const { measure, mainTree, sourceTree, treeSource, ratchetProblems, seeded } = createBudgetMeasure(helpers);

test('cli.journeys-inbox-growth.every-measured-command-prints-within-its: clause 1: every measured command prints within its main size on a seeded board [C7,N26]', async t => {
  const box = seeded();
  const main = mainTree();
  const processSample = await observeProcesses();
  try {
    // The two trees are measured side by side so the file stays inside its time limit.
    const [headSizes, mainSizes] = await Promise.all([measure(box, helpers.BIN, { processSample }), main ? measure(box, join(main, 'apps/cli/pullboard.js'), { processSample }) : {}]);
    t.diagnostic(JSON.stringify({ processObservation: processSample.sha256, mainSource: treeSource(main) ?? null, headAgentsBytes: headSizes.agents, mainAgentsBytes: mainSizes.agents ?? null }));
    assert.deepEqual(ratchetProblems(headSizes, mainSizes), [], JSON.stringify(headSizes));
  } finally {
    if (main) rmSync(main, { recursive: true, force: true });
  }
});


test('cli.inbox-growth.unpaired-process-observations: #12961 clause 2: identical normal renderer source preserves differing CPU and process-count observations as differing full text [C7,N26]', async () => {
  const box = seeded(), tree = sourceTree();
  try {
    const bin = join(tree, 'apps/cli/pullboard.js');
    const before = processObservation('9.0 /usr/bin/git status\n1.0 /usr/bin/node task.js\n');
    const after = processObservation('10.0 /usr/bin/git status\n10.0 /usr/bin/git status\n1.0 /usr/bin/node task.js\n');
    const first = await renderAgents(box, bin, before), second = await renderAgents(box, bin, after);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /git 9% \(1\)/u);
    assert.match(second.stdout, /git 20% \(2\)/u);
    assert.notEqual(first.stdout, second.stdout, 'the actual same-source renderer must retain changed telemetry');
    assert.ok(ratchetProblems({ agents: Buffer.byteLength(second.stdout) }, { agents: Buffer.byteLength(first.stdout) }).some(line => line.startsWith('agents:')), 'unpaired CPU/count input can produce the historical false growth');
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

test('cli.inbox-growth.matched-input-added-byte: #12961 clause 1: both source renderers execute independently; clause 2: a genuine added producer byte under one actual observation still fails the zero-growth ratchet [C7,N26]', async t => {
  const box = seeded(), tree = sourceTree(), sample = await observeProcesses();
  try {
    const bin = join(tree, 'apps/cli/pullboard.js'), renderer = join(tree, 'packages/seats/src/io/agent/tree.js');
    const working = await renderAgents(box, helpers.BIN, sample, { inProcess: box.inProcess });
    const workingProcess = await renderAgents(box, helpers.BIN, sample);
    assert.equal(working.status, 0, working.stderr);
    assert.equal(workingProcess.status, 0, workingProcess.stderr);
    assert.equal(working.stdout, workingProcess.stdout, 'working in-process and actual process modes retain the same complete unnormalized output under one observation');
    const before = await renderAgents(box, bin, sample);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /top local consumers: /u);
    const original = readFileSync(renderer, 'utf8');
    const prefix = 'seats holding nothing: ';
    assert.equal(original.split(prefix).length, 2, 'the real idle-seat report has one canonical prefix');
    const line = before.stdout.split('\n').find(line => line.startsWith(prefix));
    assert.ok(line && Buffer.byteLength(line) < 1023, 'add the byte to an actual short output line, not one the existing line cap already cuts');
    writeFileSync(renderer, original.replace(prefix, prefix + 'x')); // One real source byte, in an independent disposable archive only.
    const added = await renderAgents(box, bin, sample);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(Buffer.byteLength(added.stdout), Buffer.byteLength(before.stdout) + 1);
    assert.deepEqual(ratchetProblems({ agents: Buffer.byteLength(added.stdout) }, { agents: Buffer.byteLength(before.stdout) }),
      [`agents: ${Buffer.byteLength(added.stdout)} bytes, over its main size of ${Buffer.byteLength(before.stdout)}`]);
    t.diagnostic(JSON.stringify({ source: treeSource(tree), rendererBefore: createHash('sha256').update(original).digest('hex'), rendererAdded: createHash('sha256').update(readFileSync(renderer)).digest('hex'), telemetryLineBytes: Buffer.byteLength(before.stdout.split('\n').find(line => line.startsWith('top local consumers: ')) ?? ''), processObservation: sample.sha256, beforeBytes: Buffer.byteLength(before.stdout), addedBytes: Buffer.byteLength(added.stdout) }));
  } finally { rmSync(tree, { recursive: true, force: true }); }
});
