/** @pullboard-test-input source-tree */
/** Real Git ranges and native gate receipts for receipt-based pre-push decisions [C7]. */
import { shellWord } from '../../index.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { configFromSource } from '../../../../packages/config/index.js';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import {
  pushedFirstParentCommits,
  pushReceiptProblems as evaluatePushReceiptProblems,
} from '../../../../packages/git/index.js';
import {
  readGateReceipt,
  receiptBody,
  receiptStore,
} from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const ZERO = '0'.repeat(40);

/** Exercise the actual evaluator with its trusted native receipt readers supplied explicitly. */
function pushReceiptProblems(root, input) {
  return evaluatePushReceiptProblems(root, input, { readGateReceipt, receiptStore });
}


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
  const module = new URL('../../../../packages/gate/index.js', import.meta.url).href;
  const source = `import {readFileSync} from 'node:fs'; import {runGate} from ${JSON.stringify(module)};
${executionServicesSource(module)}
const config=JSON.parse(readFileSync('pullboard.json','utf8'));
const result=await runGate(process.cwd(),config,{ executionServices,trustStamp:false,landing:${landing},agent:'coordinator'});
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
  const command = 'test "$PULLBOARD_FIXTURE_AUDIT_RED" != 2 && node --test --test-reporter=tap web/audit.test.cjs';
  const box = e2e.project(command, undefined, { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/audit.test.cjs'), [
    "const {test}=require('node:test');",
    "const assert=require('node:assert/strict');",
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
  const receiptBytes = receiptBody(readGateReceipt(receiptStore(box.repo), landing.id));
  assert.equal(typeof receiptBytes, 'string', 'the native receipt exists with its exact canonical disk bytes');
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
  assert.equal(receiptBody(readGateReceipt(receiptStore(box.repo), landing.id)), receiptBytes, 'read-only evaluation cannot create a replacement green stamp');
});

/** Invoke the real additive smoke helper using the fixture's accepted policy and ordinary inherited admission. */
function nativeSmoke(box) {
  const module = new URL('../../../../packages/sandbox/src/io/smoke.js', import.meta.url).href;
  const source = `import {runPushReceiptSmoke} from ${JSON.stringify(module)};
import {checkNeedsBrowser} from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
import {checkNeedsGui} from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
import {runProfiledShellAsync,withGateSlot} from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
${executionServicesSource(new URL('../../../../packages/gate/index.js', import.meta.url).href)}
try { const run=await runPushReceiptSmoke(process.cwd(),{executionServices,agent:'coordinator'},
{checkNeedsBrowser,checkNeedsGui,runProfiledShellAsync,withGateSlot});
console.log(JSON.stringify({green:run.isGreen,policy:run.policyCommit,output:run.output})); }
catch(error) { console.log(JSON.stringify({code:error.code,message:error.message})); process.exitCode=1; }`;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
}

test('additive push smoke uses accepted policy, refuses missing configuration, and never invokes the full gate [C7]', () => {
  const box = e2e.project('node -e "require(\'node:fs\').writeFileSync(\'full-gate-ran\',\'ran\')"', undefined, { withWorktree: false });
  const absent = nativeSmoke(box);
  assert.equal(absent.status, 1, `${absent.stdout}${absent.stderr}`);
  assert.equal(JSON.parse(absent.stdout.trim().split('\n').at(-1)).code, 'NO_PUSH_SMOKE');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.pushReceiptCheck = { smoke: 'node -e "require(\'node:fs\').writeFileSync(\'smoke-ran\',\'ran\')"' };
  writeFileSync(file, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure additive smoke');
  const accepted = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  // Uncommitted candidate policy cannot replace the accepted smoke with the full gate command.
  writeFileSync(file, JSON.stringify({ ...config, pushReceiptCheck: { smoke: config.gate } }));
  const ran = nativeSmoke(box);
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.deepEqual(JSON.parse(ran.stdout.trim().split('\n').at(-1)).policy, accepted);
  assert.equal(readFileSync(join(box.repo, 'smoke-ran'), 'utf8'), 'ran');
  assert.equal(box.git(box.repo, 'status', '--porcelain').includes('full-gate-ran'), false);
});


test('additive smoke config is retained and validated without activating the replacement hook [C7]', () => {
  const command = 'node test/smoke.js';
  assert.deepEqual(configFromSource(JSON.stringify({ pushReceiptCheck: { smoke: command } })).pushReceiptCheck, { smoke: command });
  assert.equal(configFromSource('{}').pushReceiptCheck, undefined);
  for (const value of [null, [], {}, { smoke: '' }, { smoke: false }]) {
    assert.throws(() => configFromSource(JSON.stringify({ pushReceiptCheck: value })), { code: 'BAD_CONFIG' });
  }
  // A key this validator version does not know is ignored, never kept or activated [N26].
  assert.deepEqual(configFromSource(JSON.stringify({ pushReceiptCheck: { smoke: command, enabled: true } })).pushReceiptCheck, { smoke: command });
});


test('native push adapter checks real ordered receipts and exact open audit repairs [C7]', { timeout: 120_000 }, () => {
  const installedRunner = resolve(import.meta.dirname, '../../../../packages/gate/src/io/run/tests.js');
  const box = e2e.project(`node ${shellWord(installedRunner)}`, undefined, { withWorktree: false });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/audit.test.js'), [
    "import {test} from 'node:test'; import assert from 'node:assert/strict';",
    "test('native push audit [C7]',()=>assert.notEqual(process.env.PULLBOARD_FIXTURE_AUDIT_RED,'1'));",
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: install real native push component fixture');
  const module = new URL('../../tests/fixtures/evidence.js', import.meta.url).href;
  const source = `import {assertNativePushEvidence} from ${JSON.stringify(module)}; await assertNativePushEvidence(process.cwd()); console.log('native push component controls reached');`;
  const ran = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(ran.status, 0, ran.failure ?? `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stdout, /native push component controls reached/u);
});

test('additive native CLI refuses malformed actual pre-push stdin before smoke [C7]', () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const ran = runFixtureChild(process.execPath, [fileURLToPath(new URL('../../pullboard.js', import.meta.url)), 'push-receipts', '--json'], {
    cwd: box.repo, env: box.env, input: 'malformed pre-push record\n', encoding: 'utf8',
  });
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(`${ran.stdout}${ran.stderr}`, /PUSH_RECEIPT_RANGE/u);
});
