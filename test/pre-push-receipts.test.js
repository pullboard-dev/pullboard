/** Real Git ranges and native gate receipts for receipt-based pre-push decisions [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  pushedFirstParentCommits,
  pushReceiptProblems,
} from '../src/pre-push-receipts.js';
import {
  readGateReceipt,
  receiptStore,
} from '../src/gate-run-receipt.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const ZERO = '0'.repeat(40);

/** Git's four-field stdin record names the remote object, not a guessed tracking ref. */
function update(local, remote = ZERO, ref = 'refs/heads/main') {
  return `${ref} ${local} ${ref} ${remote}\n`;
}

/** Commit one distinct fixture object without changing any outside checkout. */
function commit(box, root, file) {
  writeFileSync(join(root, file), `${file}\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', `chore: record ${file}`);
  return box.git(root, 'rev-parse', 'HEAD').trim();
}

test('push ranges check first parents, direct commits, new refs and all ref records [C7]', () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'ranges');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const base = commit(box, root, 'base');
  box.git(root, 'checkout', '-q', '-b', 'topic');
  const topic = commit(box, root, 'topic');
  box.git(root, 'checkout', '-q', 'main');
  const direct = commit(box, root, 'direct');
  box.git(root, 'merge', '-q', '--no-ff', '-m', 'chore: merge topic', topic);
  const merge = box.git(root, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(pushedFirstParentCommits(root, update(merge, base)), [direct, merge]);
  assert.deepEqual(pushedFirstParentCommits(root, update(merge, base) + update(merge, base, 'refs/heads/copy')), [direct, merge]);
  assert.deepEqual(pushedFirstParentCommits(root, update(merge)), [base, direct, merge], 'a new ref does not silently exempt existing history');
  assert.deepEqual(pushedFirstParentCommits(root, update(ZERO, merge)), [], 'deletion introduces no commits');
  assert.deepEqual(pushedFirstParentCommits(root, update(base, merge)), [], 'a rewind adds no first-parent commits');
  assert.throws(() => pushedFirstParentCommits(root, update(merge, 'a'.repeat(40))), { code: 'PUSH_RECEIPT_RANGE' });
  assert.throws(() => pushedFirstParentCommits(root, `${update(merge, base)}malformed\n`), { code: 'PUSH_RECEIPT_RANGE' });
});

/** Run the actual private receipt writer through normal gate admission in this isolated fixture. */
function nativeReceipt(box, { landing = false, red = false, unparsed = false } = {}) {
  const module = new URL('../src/gate.js', import.meta.url).href;
  const source = `import {readFileSync} from 'node:fs'; import {runGate} from ${JSON.stringify(module)};
const config=JSON.parse(readFileSync('pullboard.json','utf8'));
const result=await runGate(process.cwd(),config,{trustStamp:false,landing:${landing},agent:'coordinator'});
console.log(JSON.stringify({receiptId:result.receiptId,green:result.isGreen,output:result.output}));`;
  const ran = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: { ...box.env, PULLBOARD_FIXTURE_AUDIT_RED: unparsed ? '2' : red ? '1' : '0' }, encoding: 'utf8',
  });
  assert.equal(ran.status, 0, ran.failure ?? `${ran.stdout}${ran.stderr}`);
  const result = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.ok(result.receiptId, JSON.stringify(result));
  assert.equal(result.green, !red && !unparsed, result.output);
  return readGateReceipt(receiptStore(box.repo), result.receiptId);
}

test('push evidence refuses missing landings and unfiled newest audit failures without rerunning the full suite [C7]', () => {
  const command = 'node --test --test-reporter=tap web/audit.test.cjs';
  const box = e2e.project(command, undefined, { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/audit.test.cjs'), [
    "const {test}=require('node:test');",
    "const assert=require('node:assert/strict');",
    "if(process.env.PULLBOARD_FIXTURE_AUDIT_RED==='2')process.exit(2);",
    "test('audit failure [C7]',()=>assert.notEqual(process.env.PULLBOARD_FIXTURE_AUDIT_RED,'1'));",
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add audit fixture');
  const head = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const landing = nativeReceipt(box, { landing: true });
  const greenAudit = nativeReceipt(box);
  const redAudit = nativeReceipt(box, { red: true });
  const unparsedAudit = nativeReceipt(box, { unparsed: true });
  assert.equal(redAudit.failures.length, 1, 'a real failing committed test has an exact identity');
  const input = { commits: [head], landingReceipts: [{ commit: head, receiptId: landing.id }],
    audits: [{ receiptId: greenAudit.id }], filings: [], items: [], landingCommand: command, auditCommand: command };
  const receiptBytes = readFileSync(join(receiptStore(box.repo), `${landing.id}.json`), 'utf8');
  assert.deepEqual(pushReceiptProblems(box.repo, input), []);
  assert.match(pushReceiptProblems(box.repo, { ...input, landingReceipts: [] }).join('\n'), /lacks its exact green landing receipt/u);
  assert.match(pushReceiptProblems(box.repo, { ...input, landingReceipts: [{ commit: head, receiptId: greenAudit.id }] }).join('\n'), /lacks its exact green landing receipt/u);
  const latestRed = { ...input, audits: [...input.audits, { receiptId: redAudit.id }] };
  assert.match(pushReceiptProblems(box.repo, latestRed).join('\n'), /no linked open repair item/u);
  const filing = { receiptId: redAudit.id, ...redAudit.failures[0], item: 1 };
  const filed = { ...latestRed, filings: [filing], items: [{ item_id: 1, item_status: 'open' }] };
  assert.deepEqual(pushReceiptProblems(box.repo, filed), [], 'filing the exact latest failure permits the evidence stage');
  assert.match(pushReceiptProblems(box.repo, { ...filed, filings: [{ ...filing, receiptId: greenAudit.id }] }).join('\n'), /no linked open repair item/u);
  assert.match(pushReceiptProblems(box.repo, { ...filed, items: [{ item_id: 1, item_status: 'withdrawn' }] }).join('\n'), /no linked open repair item/u);
  assert.match(pushReceiptProblems(box.repo, { ...input, audits: [...input.audits, { receiptId: 'missing' }] }).join('\n'), /latest full audit has no bound receipt/u);
  assert.match(pushReceiptProblems(box.repo, { ...input, audits: [{ receiptId: unparsedAudit.id }] }).join('\n'), /red without identified failures/u);
  assert.match(pushReceiptProblems(box.repo, { ...input, landingCommand: 'another gate' }).join('\n'), /lacks its exact green landing receipt/u);
  assert.equal(readFileSync(join(receiptStore(box.repo), `${landing.id}.json`), 'utf8'), receiptBytes, 'read-only evaluation cannot create a replacement green stamp');
});
