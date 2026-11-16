/** @pullboard-test-loads packages/codemap/src/io/contracts/audit.js packages/codemap/src/io/contracts/file.js packages/codemap/src/io/contracts/weaken.js */
/** A shape mismatch is refused, a weakening needs the owner, and an audit gap drafts a contract file [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { auditContractGaps } from '../../src/io/contracts/audit.js';
import { readContractFile } from '../../src/io/contracts/file.js';
import { checkContractWeakening } from '../../src/io/contracts/weaken.js';

const seal = { name: 'seal', params: ['key', 'text'], returns: 'string' };
const open = { name: 'open', params: ['key'], returns: 'string' };
const audit = (extra, root) => ({ enabled: true, consumer: 'packages/gate', provider: 'packages/kernel', declared: [seal], actual: [seal], draftPath: join(root, 'draft.json'), ...extra });

test('clause 1: a shape mismatch is refused CONTRACT_SHAPE_MISMATCH naming the export [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-contracts-mismatch-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(() => auditContractGaps(audit({ actual: [{ ...seal, params: ['key'] }] }, fixture.root)), error => {
    assert.equal(error.code ?? error.rule, 'CONTRACT_SHAPE_MISMATCH');
    assert.match(String(error.message), /seal: params: declared \(key, text\), actual \(key\)/u);
    assert.match(String(error.message), /retry/u);
    return true;
  });
});

test('clause 1: a weakening needs the owner and passes with the owner\'s approval [C7]', () => {
  const change = { enabled: true, owner: 'packages/kernel', before: [seal], after: [{ ...seal, params: ['key'] }], beforeFingerprint: 'a', afterFingerprint: 'b' };
  assert.throws(() => checkContractWeakening(change), /CONTRACT_WEAKENED/u);
  assert.equal(checkContractWeakening({ ...change, approvedBy: ['packages/kernel'] }).weakened.length, 1);
});

test('clause 1: an audit gap drafts a contract file holding only the undeclared export [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-contracts-gap-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { drafted } = auditContractGaps(audit({ actual: [seal, open] }, fixture.root));
  assert.equal(drafted.length, 1);
  assert.equal(drafted[0], join(fixture.root, 'draft.json'));
  assert.deepEqual(readContractFile(drafted[0]), { consumer: 'packages/gate', provider: 'packages/kernel', exports: [open] });
});

test('clause 1: with the audit setting off or no gap nothing is refused or written [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-contracts-off-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.deepEqual(auditContractGaps(audit({ enabled: false, actual: [seal, open] }, fixture.root)), { drafted: [] });
  assert.deepEqual(auditContractGaps(audit({}, fixture.root)), { drafted: [] });
});
