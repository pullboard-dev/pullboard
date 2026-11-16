/** A frozen check's outcome travels with the accept that follows a real check run [V19,V8]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { sandbox } from '../../tests/fixtures/verdict-check.js';
import { project } from '../../tests/fixtures/verdict-check.js';
import { succeeds } from '../../tests/fixtures/verdict-check.js';
import { submitted } from '../../tests/fixtures/verdict-check.js';
import { clean } from '../../tests/fixtures/verdict-check.js';

test('accept records green in its event and JSON after a real frozen check [V19,V8]', async (t) => {
  const started = Date.now();
  /** Print the elapsed seconds at each step, so a slow run on a loaded runner names the step it stalled in [C7]. */
  const step = (name) => t.diagnostic(`check-checked step ${name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    step('project ready');
    const checked = await submitted(box, repo, web, 'Checked accept', 'node --check web/item-1.js');
    step('item submitted');
    await succeeds(box, repo, 'check', String(checked.id), '--yes'); // Diagnostics must not block an existing frozen check while main is detached for review.
    step('first check green');
    const checkedSource = join(repo, 'web', `item-${checked.id}.js`);
    const originalSource = readFileSync(checkedSource, 'utf8');
    writeFileSync(checkedSource, 'const = ;\n'); // Keep the negative compiler case unambiguous; Node22 can silently accept invalid detected-ESM .js (#65202).
    // Process-level by nature: this is the Node compiler itself, not the CLI, so no in-process form exists.
    const reference = runFixtureChild(process.execPath, ['--check', checkedSource], { cwd: repo, env: box.env, encoding: 'utf8' });
    assert.equal(reference.status, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'direct compiler reference', status: reference.status,
      stdout: reference.stdout, stderr: reference.stderr, source: readFileSync(checkedSource, 'utf8'), inheritedTestContext: Boolean(box.env.NODE_TEST_CONTEXT) }), box.env));
    // Process-level by nature: the failure-diagnostics notice comes from a child the check starts, which in-process dispatch does not reproduce.
    const redCheck = box.spawn(repo, 'check', String(checked.id), '--yes', '--json');
    assert.equal(redCheck.code, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'real check after direct compiler red', redCheck, source: readFileSync(checkedSource, 'utf8') }), box.env));
    step('red check done');
    assert.equal(JSON.parse(redCheck.out).green, false);
    assert.match(redCheck.err, /failure diagnostics could not finish \(NO_POLICY\).*original result stays red/u);
    writeFileSync(checkedSource, originalSource);
    const checkedJson = JSON.parse(await succeeds(box, repo, 'verify', String(checked.id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json'));
    step('accept done');
    assert.equal(checkedJson.check, 'green');
    const checkedEvent = JSON.parse(await succeeds(box, repo, 'log', String(checked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(checkedEvent.event_detail).check, 'green');
    const checkedShow = JSON.parse(await succeeds(box, repo, 'show', String(checked.id), '--json'));
    assert.equal(checkedShow.verdicts.at(-1).check, 'green');
    assert.match(await succeeds(box, repo, 'show', String(checked.id)), /check: green/);
  } finally { clean(box); }
});
