/** After a landing is recorded the audit is a board job: it writes an audit proof-run naming the item and its landed commit, unasked [C7,#4743]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { BIN } from '../../../../../../apps/cli/tests/fixtures/cockpit/machine.js';
import { machine } from '../../../../../../apps/cli/tests/fixtures/cockpit/machine.js';
import { project } from '../../../../../../apps/cli/tests/fixtures/cockpit/machine.js';
import { fileFixtureItem } from '../../../../../../apps/cli/tests/fixtures/testkit.js';

test('clause 1: after a forced merge the audit runs unasked and the item history shows an audit proof-run naming the item and the landed commit [C7,#4743]', () => {
  const box = machine(), alpha = project(box, 'post-landing-audit');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'A landed fixture item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
    run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
  const audits = () => JSON.parse(run('log', '1', '--json').stdout).events.filter(event => event.event_kind === 'proof-run')
    .map(event => JSON.parse(event.event_detail).receipt).filter(receipt => receipt.kind === 'audit');
  assert.deepEqual(audits(), [], 'nothing is audited before a landing');
  const forced = run('merged', '1', head, '--forced', 'landed by hand around the gate');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  const [audit] = audits();
  assert.equal(audits().length, 1, 'one audit per landing');
  assert.equal(audit.item, 1);
  assert.equal(audit.commit, head, 'the audit names the landed commit');
  assert.equal(audit.id, `audit:1:${head.slice(0, 12)}`);
});
