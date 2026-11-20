/** Signed test coverage preserves named checks, neighboring failures and the unchanged budget [V2,V4,M1]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { barCoverageCommand } from '../../../../verify/index.js';
import { normalizeBarCoverage } from '../../../../verify/index.js';
import { prepareBarCoverage } from '../../../../verify/index.js';
import { barTestPath } from '../../../../verify/index.js';
import { barCoverageForPolicy } from '../../../../verify/index.js';
import { requireSubmitComposition } from '../../../../items/index.js';
import { nativeBarActor } from '../../../../verify/index.js';
import { baselineTestEvidence } from '../../../heavy.js';
import { configFromSource } from '../../../../config/index.js';
import { runFixtureChild } from '../../fixtures/child.js';

const SHA = 'a'.repeat(40);
/** Synthetic observations test schema and arithmetic, not an actual performance claim. */
function observed(durationMs, selection = 'whole-file') {
  return { durationMs, selection, ref: 'private fixture receipt', sha256: 'b'.repeat(64), source: SHA, runtime: 'synthetic fixture runtime', outcome: 'pass' };
}
/** One bar keeps its original named command while adding a whole-file obligation. */
function example() {
  const path = 'test/adjacent.test.js';
  const item = { item_id: 1, item_check: `node --test --test-name-pattern named ${path}`, item_brief: `Files: ${path}\nTest: named proves the behavior` };
  const plan = { version: 1, sourceMain: SHA, policyKey: 'c'.repeat(64), sourceCheck: item.item_check, timeoutMs: 1000, runner: 'node --test', required: [path],
    files: [{ path, mode: 'whole', evidence: observed(400) }], named: observed(100, 'named-check'), installMs: 0 };
  return { item, plan, path };
}
/** A real private Git repository supplies accepted main and committed test inventory. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-bar-coverage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  delete env.NODE_TEST_CONTEXT; // A nested CLI/test runner is a normal process, not this test worker.
  /** Keep hooks out of this synthetic project; product hooks and admission remain unchanged. */
  const git = (...args) => {
    const ran = runFixtureChild('git', ['-c','core.hooksPath=/dev/null',...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.failure ?? ran.stderr);
    return ran.stdout.trim();
  };
  git('init','-q','-b','main');
  mkdirSync(join(root,'test'));
  writeFileSync(join(root,'test/adjacent.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('named',()=>assert.ok(true));\ntest('neighbor',()=>assert.fail('neighbor still fails'));\n");
  git('add','.');git('commit','-qm','test: private bar fixture');
  return { root, git, env };
}

test('gate.logic-reporter-coverage.a-passing-named-check-cannot: [V2,V4] a passing named check cannot hide the failing neighboring case', t => {
  const f = repository(t); const { item, plan } = example();
  const named = runFixtureChild('/bin/sh',['-c',item.item_check],{cwd:f.root,env:f.env,encoding:'utf8'});
  assert.equal(named.status,0,named.stderr);
  const whole = runFixtureChild('/bin/sh',['-c',barCoverageCommand(item.item_check,normalizeBarCoverage(plan,item))],{cwd:f.root,env:f.env,encoding:'utf8'});
  assert.notEqual(whole.status,0,whole.stdout+whole.stderr);
  assert.match(whole.stdout,/neighbor still fails/);
  assert.ok(barCoverageCommand(item.item_check,plan).startsWith(`(\n${item.item_check}\n)`),'original shell command remains intact');
});

test('gate.logic-reporter-coverage.unknown-named-only-or-red: [V2,V4] unknown, named-only or red duration cannot qualify a fast whole file', () => {
  const { item, plan } = example();
  for (const evidence of [null, observed(400,'named-check'), {...observed(400),outcome:'fail'}, {...observed(400),source:'unknown'}]) {
    assert.throws(()=>normalizeBarCoverage({...plan,files:[{...plan.files[0],evidence}]},item),e=>e.code==='BAR_COVERAGE');
  }
  assert.throws(()=>normalizeBarCoverage({...plan,files:[]},item),e=>e.code==='BAR_COVERAGE');
  assert.throws(()=>normalizeBarCoverage({...plan,files:[plan.files[0],plan.files[0]]},item),e=>e.code==='BAR_COVERAGE');
  assert.throws(()=>normalizeBarCoverage({...plan,required:['../outside.test.js']},item),e=>e.code==='BAR_COVERAGE');
});

test('gate.logic-reporter-coverage.a-slow-file-needs-explicit: [V2,V4] a slow file needs explicit landing coverage and keeps its named cases', () => {
  const { item, plan, path } = example();
  const slow = {...plan,files:[{path,mode:'landing',evidence:{...observed(1500),outcome:'timeout'},namedCases:['named']}]};
  assert.throws(()=>normalizeBarCoverage(slow,item),e=>e.code==='BAR_COVERAGE');
  item.item_brief += `\nLanding coverage: ${path} is covered by the landing gate`;
  const normalized = normalizeBarCoverage(slow,item);
  assert.equal(barCoverageCommand(item.item_check,normalized),item.item_check);
  assert.throws(()=>normalizeBarCoverage({...slow,files:[{...slow.files[0],evidence:observed(200)}]},item),e=>e.code==='BAR_COVERAGE','unknown or fast files cannot be silently deferred');
  assert.equal(normalized.timeoutMs,1000);
});

test('gate.logic-reporter-coverage.the-budget-includes-named-install: [V2,V4] the budget includes named, install and all whole files, without raising the timeout', () => {
  const { item, plan } = example();
  assert.throws(()=>normalizeBarCoverage({...plan,named:observed(700,'named-check')},item),e=>e.code==='BAR_COVERAGE');
  assert.throws(()=>normalizeBarCoverage({...plan,installMs:600,install:observed(600,'install')},item),e=>e.code==='BAR_COVERAGE');
  const equality = normalizeBarCoverage({...plan,named:observed(600,'named-check')},item);
  assert.equal(equality.totalMs,1000);
  assert.equal(equality.timeoutMs,1000);
});

test('gate.logic-reporter-coverage.accepted-project-inventory-and-runner: [V2,V4] accepted project inventory and runner override a supplied plan without executing it', t => {
  const f = repository(t); const { item, plan } = example();
  item.item_brief = item.item_brief.replace('Files: test/adjacent.test.js', 'Files: test/adjacent.test.js, test/new.test.js');
  const sourceMain = f.git('rev-parse','HEAD');
  const config = configFromSource('{"affectedTests":"node custom-runner.js","check":{"timeout":"2s"}}');
  const file=join(f.root,'coverage.json');
  writeFileSync(file,JSON.stringify({...plan,runner:'false',timeoutMs:999999,required:[]}));
  const prepared = prepareBarCoverage(f.root,item,{commit:sourceMain,config},file);
  assert.deepEqual(prepared.required,['test/adjacent.test.js']);
  assert.equal(prepared.runner,'node custom-runner.js');
  assert.equal(prepared.timeoutMs,2000);
  assert.equal(prepared.sourceMain,sourceMain);
  assert.ok(barTestPath('tests/test_example.py',['**/test_*.py']));
  assert.equal(barTestPath('src/component.js',config.claim.barTestFiles),false);
  assert.throws(()=>prepareBarCoverage(f.root,item,{commit:sourceMain,config}),e=>e.code==='BAR_COVERAGE');
});

test('gate.logic-reporter-coverage.a-conflict-free-candidate-must: [M1,V4] a conflict-free candidate must contain the exact main used for submit proof', t => {
  const f=repository(t);const initial=f.git('rev-parse','HEAD');
  f.git('checkout','-qb','candidate');writeFileSync(join(f.root,'candidate.txt'),'candidate');f.git('add','.');f.git('commit','-qm','test: candidate');const candidate=f.git('rev-parse','HEAD');
  f.git('checkout','-q','main');writeFileSync(join(f.root,'main.txt'),'main');f.git('add','.');f.git('commit','-qm','test: main');const main=f.git('rev-parse','HEAD');
  assert.throws(()=>requireSubmitComposition(f.root,candidate,{commit:main},main),e=>e.code==='MAIN_NOT_COMPOSED');
  f.git('checkout','-q','candidate');f.git('merge','-qm','test: composition','main');const composed=f.git('rev-parse','HEAD');
  assert.doesNotThrow(()=>requireSubmitComposition(f.root,composed,{commit:main},main));
  assert.throws(()=>requireSubmitComposition(f.root,composed,{commit:main},initial),e=>e.code==='MAIN_NOT_COMPOSED','a different authority snapshot cannot inherit this proof');
});


test('gate.logic-reporter-coverage.baseline-witness-distinguishes-observed-failure: [V2,V4] baseline witness distinguishes observed failure, absent case and unrelated setup failure', () => {
  const failed = baselineTestEvidence('TAP version 13\nnot ok 1 - named witness\n  ---\n  duration_ms: 1\n  ...\n', 'node --test');
  assert.deepEqual(failed, { failed: ['named witness'], passed: [], failedCases: [], noTestsMatched: false });
  assert.equal(baselineTestEvidence('run-tests: NO_TESTS_MATCHED: no named case', 'node apps/cli/src/io/run/tests.js').noTestsMatched, true);
  assert.deepEqual(baselineTestEvidence('Error: module missing', 'node --test'), { failed: [], passed: [], failedCases: [], noTestsMatched: false });
});


test('gate.logic-reporter-coverage.new-existing-test-files-or: [V2,V4] new existing test files or accepted execution settings need a new coverage signature', t => {
  const f=repository(t);const {item,plan}=example();
  item.item_brief=item.item_brief.replace('Files: test/adjacent.test.js','Files: test/adjacent.test.js, test/new.test.js');
  const config=configFromSource('{"affectedTests":"node --test","check":{"timeout":"2s"}}');
  const file=join(f.root,'record.json');writeFileSync(file,JSON.stringify(plan));
  const policy={commit:f.git('rev-parse','HEAD'),config};const prepared=prepareBarCoverage(f.root,item,policy,file);
  writeFileSync(join(f.root,'unrelated.txt'),'unrelated');f.git('add','unrelated.txt');f.git('commit','-qm','test: unrelated');
  assert.doesNotThrow(()=>barCoverageForPolicy(f.root,item,prepared,{commit:f.git('rev-parse','HEAD'),config}));
  writeFileSync(join(f.root,'test/new.test.js'),'// a newly committed test file');f.git('add','test/new.test.js');f.git('commit','-qm','test: new brief file');
  assert.throws(()=>barCoverageForPolicy(f.root,item,prepared,{commit:f.git('rev-parse','HEAD'),config}),e=>e.code==='BAR_NOT_READY');
  assert.throws(()=>barCoverageForPolicy(f.root,item,prepared,{...policy,config:{...config,affectedTests:'node other.js'}}),e=>e.code==='BAR_NOT_READY');
});


test('gate.logic-reporter-coverage.native-authorship-captures-only-the: [V1,H16] native authorship captures only the current runtime, not a historical seat fallback', () => {
  assert.equal(nativeBarActor({}),null);
  const first=nativeBarActor({CLAUDE_CODE_SESSION_ID:'synthetic-private-author-a'});
  const second=nativeBarActor({CLAUDE_CODE_SESSION_ID:'synthetic-private-author-b'});
  assert.equal(first.session,first.parent);
  assert.notEqual(first.parent,second.parent);
});


test('gate.logic-reporter-coverage.a-declared-helper-parent-applies: [V1,H16] a declared helper parent applies only to the actual session that joined', () => {
  const env={CLAUDE_CODE_SESSION_ID:'synthetic-private-helper'};
  const own=nativeBarActor(env);
  const parent='e'.repeat(64);
  assert.equal(nativeBarActor(env,{session:own.session,parent}).parent,parent);
  const formerRoot='f'.repeat(64);
  assert.equal(nativeBarActor(env,{session:formerRoot,parent:formerRoot}).parent,own.session,'a replacement coordinator captures its own root identity');
  assert.throws(()=>nativeBarActor(env,{session:formerRoot,parent}),{code:'BAR_PARENT_UNKNOWN'},'a restarted known helper has no evidence of an independent parent');
});
