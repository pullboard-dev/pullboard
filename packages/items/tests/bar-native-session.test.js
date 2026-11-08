/** Real private CLI sessions prove bar signing, freezing and takeover attribution [B4,V1,V2,H16]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runFixtureChild } from "../../../test/fixture-child.js";
import { join } from 'node:path';
import { createE2eHelpers } from "../../../test/e2e-helpers.js";
import * as store from "../../../src/board.js";
import { openBoard } from "../../../apps/lib/index.js";
import { parentSessionDigest } from "../src/shell/parent-session.js";

const fixtures=createE2eHelpers();
after(fixtures.cleanup);
/** Run only inside a private fixture; synthetic runtime identities never touch the user's board. */
function act(box, session, cwd, ...args) {
  box.env.CLAUDE_CODE_SESSION_ID=session;
  return box.run(cwd,...args);
}
/** Model a person's own terminal only inside this isolated fixture, preserving real admission markers. */
function personAct(box,cwd,...args) {
  const previous=box.env.CLAUDE_CODE_SESSION_ID;delete box.env.CLAUDE_CODE_SESSION_ID;
  try{return box.run(cwd,...args);}finally{box.env.CLAUDE_CODE_SESSION_ID=previous;}
}
/** Keep command diagnostics attached to every successful private move. */
function succeeds(result) { assert.equal(result.code,0,`${result.out}\n${result.err}`); return result; }
/** A real historical green whole file can be measured before the named main-red baseline is created. */
function setup(wholeCoverage = false) {
  const sandbox=fixtures.sandbox();delete sandbox.env.NODE_TEST_CONTEXT;
  sandbox.env.PULLBOARD_MODEL='Private fixture';
  const box=fixtures.project('true',sandbox);
  succeeds(act(box,'private-author-a',box.repo,'join','coordinator','--model','Private author'));
  mkdirSync(join(box.repo,'test'));
  writeFileSync(join(box.repo,'test','witness.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('named witness',()=>assert.ok(existsSync('web/ready.txt')));\ntest('neighbor witness',()=>assert.ok(true));\n");
  if (wholeCoverage) {
    const config=JSON.parse(readFileSync(join(box.repo,'pullboard.json'),'utf8'));
    config.affectedTests='node --test --test-reporter=tap';config.check={timeout:'5m'};config.lanes.web.owns.push('test/');
    writeFileSync(join(box.repo,'pullboard.json'),JSON.stringify(config));
    mkdirSync(join(box.repo,'web'));writeFileSync(join(box.repo,'web','ready.txt'),'ready');
  }
  box.git(box.repo,'add','-A');box.git(box.repo,'commit','-qm','test: private named witness');
  if (wholeCoverage) {
    const started=performance.now();
    const ran=runFixtureChild(process.execPath,['--test','--test-reporter=tap','test/witness.test.mjs'],{cwd:box.repo,env:box.env,encoding:'utf8'});
    const durationMs=performance.now()-started;assert.equal(ran.status,0,ran.failure??ran.stderr);assert.match(ran.stdout,/# pass 2/);
    const ref=join(box.dir,'whole-green.log');writeFileSync(ref,ran.stdout);
    box.wholeEvidence={durationMs,selection:'whole-file',ref,sha256:createHash('sha256').update(ran.stdout).digest('hex'),source:box.git(box.repo,'rev-parse','HEAD'),runtime:process.version,outcome:'pass'};
    rmSync(join(box.repo,'web','ready.txt'));box.git(box.repo,'add','-A');box.git(box.repo,'commit','-qm','test: reproduce missing output at main');
  }
  succeeds(act(box,'private-author-a',box.repo,'bar','ready','on'));
  return box;
}
/** Add a buildable bar with a genuine red named-case baseline at private main. */
function add(box,author,person = false) {
  const check='node --test --test-reporter=tap --test-name-pattern "named witness" test/witness.test.mjs';
  const run=(...args)=>person ? personAct(box,box.repo,...args,'--as','person') : act(box,author,box.repo,...args);
  const result=succeeds(run('add','web','Ready output','--criterion','web/ready.txt exists','--specs','G1','--route','mid','--check',check,'--wait',
    '--brief',`Files: web/ready.txt${box.wholeEvidence ? ', test/witness.test.mjs' : ''}\nTest: named witness asserts the output exists\nNamed test: named witness\nMeasurements: no quantitative bounds\nReviewer edges: absent output and restart`,'--json'));
  const item=JSON.parse(result.out).item;
  assert.equal(item.item_check_baseline.result,'red');
  assert.ok(item.item_check_baseline.testEvidence.failed.some(name=>name.includes('named witness')));
  return item.item_id;
}
/** Read a private board through its normal public API, never raw fixture writes. */
function readItem(box,id) {
  const board=openBoard(join(box.repo,'.git','pullboard','board.sqlite'));
  try{return store.getItem(board,id);}finally{store.closeBoard(board);}
}

test('[B4,V1,V2,H16] real native sessions sign and freeze one bar before normal submit and review',()=>{
  const box=setup(true);const id=add(box,'private-author-a');
  const builder=join(box.dir,'private-builder');box.git(box.repo,'worktree','add','-qb','web/private-builder',builder,'main');
  box.git(builder,'merge','--ff-only','main');
  succeeds(act(box,'private-builder',builder,'join','web','--model','Private builder'));
  const unsigned=act(box,'private-builder',builder,'claim',String(id));
  assert.notEqual(unsigned.code,0);assert.match(unsigned.err,/BAR_NOT_READY/);
  const reviewer=join(box.dir,'outside-review');box.git(box.repo,'worktree','add','-qb','api/outside',reviewer,'main');
  succeeds(act(box,'private-reviewer',reviewer,'join','api','--model','Private reviewer'));
  const unknownDuration=act(box,'private-reviewer',reviewer,'bar','sign',String(id),'--note','Whole coverage still needs measured evidence.');
  assert.notEqual(unknownDuration.code,0);assert.match(unknownDuration.err,/BAR_COVERAGE/);
  const baseline=readItem(box,id).item_check_baseline;
  const baselineRef=join(box.dir,'named-red.json');const baselineText=JSON.stringify(baseline);writeFileSync(baselineRef,baselineText);
  const coverageFile=join(box.dir,'coverage.json');
  writeFileSync(coverageFile,JSON.stringify({files:[{path:'test/witness.test.mjs',mode:'whole',evidence:box.wholeEvidence}],
    named:{durationMs:baseline.seconds*1000,selection:'named-check',ref:baselineRef,sha256:createHash('sha256').update(baselineText).digest('hex'),source:baseline.main,runtime:process.version,outcome:'fail'}}));
  const self=act(box,'private-author-a',box.repo,'bar','sign',String(id),'--coverage-file',coverageFile,'--note','can be built and graded alike');
  assert.notEqual(self.code,0);assert.match(self.err,/BAR_SELF_SIGN/);
  succeeds(act(box,'private-reviewer',reviewer,'bar','sign',String(id),'--coverage-file',coverageFile,'--note','Builder can meet this witness; measured whole-file coverage fits and two reviewers can grade absent and present output alike.'));
  succeeds(act(box,'private-builder',builder,'claim',String(id)));
  const frozen=JSON.parse(readItem(box,id).item_frozen);
  assert.match(frozen.sourceCheck,/named witness/);assert.deepEqual(frozen.barCoverage.required,['test/witness.test.mjs']);assert.match(frozen.check,/node --test --test-reporter=tap '.\/test\/witness\.test\.mjs'/);assert.equal(frozen.barCoverage.files[0].evidence.sha256,box.wholeEvidence.sha256);
  mkdirSync(join(builder,'web'),{recursive:true});writeFileSync(join(builder,'web','ready.txt'),'ready');
  box.git(builder,'add','web/ready.txt');box.git(builder,'commit','-qm','feat(web): ready output [G1]');
  succeeds(act(box,'private-builder',builder,'submit',String(id)));
  const head=box.git(builder,'rev-parse','HEAD');box.git(reviewer,'switch','--detach',head);
  succeeds(act(box,'private-reviewer',reviewer,'verify',String(id),'accept','--note','The real named witness passes with ready output present.'));
  assert.equal(readItem(box,id).item_status,'verified');
});

test('[V1,H16] a supported coordinator takeover cannot let its honestly joined helper sign',()=>{
  const box=setup();
  succeeds(act(box,'private-author-b',box.repo,'takeover'));
  const id=add(box,'private-author-b');
  const helper=join(box.dir,'new-author-helper');box.git(box.repo,'worktree','add','-qb','api/helper',helper,'main');
  succeeds(act(box,'private-helper',helper,'join','api','--model','Private helper','--parent','private-author-b'));
  const self=act(box,'private-helper',helper,'bar','sign',String(id),'--note','I am a helper of this author, so this must be refused.');
  assert.notEqual(self.code,0);assert.match(self.err,/BAR_SELF_SIGN/);
  const board=openBoard(join(box.repo,'.git','pullboard','board.sqlite'));
  try {
    assert.equal(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('agent_session:coordinator').meta_value,parentSessionDigest('private-author-a'),'takeover did not rewrite historical seat identity');
  }finally{store.closeBoard(board);}
});


test('[V1,H16] a helper takeover with unknown current parent fails closed instead of signing its parent’s bar',()=>{
  const box=setup();const id=add(box,'private-author-a');
  const helper=join(box.dir,'restarted-helper');box.git(box.repo,'worktree','add','-qb','api/restarted',helper,'main');
  succeeds(act(box,'private-helper-before',helper,'join','api','--model','Private helper','--parent','private-author-a'));
  succeeds(act(box,'private-helper-after',helper,'takeover'));
  const signed=act(box,'private-helper-after',helper,'bar','sign',String(id),'--note','A restart must not turn a helper into an independent author.');
  assert.notEqual(signed.code,0,`${signed.out}\n${signed.err}`);assert.match(signed.err,/BAR_PARENT_UNKNOWN/);
});


test('[B4,V1,H16,B26] the authenticated person and native agents can sign each other’s bars without invented parents',()=>{
  const box=setup();const personItem=add(box,'private-author-a',true);
  const reviewer=join(box.dir,'person-bar-peer');box.git(box.repo,'worktree','add','-qb','api/person-peer',reviewer,'main');
  succeeds(act(box,'private-person-peer',reviewer,'join','api','--model','Private reviewer','--parent','private-author-a'));
  succeeds(act(box,'private-person-peer',reviewer,'bar','sign',String(personItem),'--note','The person’s bar has a real red witness and is buildable.'));
  const personBar=JSON.parse(succeeds(act(box,'private-person-peer',reviewer,'bar',String(personItem),'--json')).out);
  assert.ok(Object.values(personBar.revision.authors).every(author=>author.authority==='person' && author.parent===null));
  const agentItem=add(box,'private-author-a');
  succeeds(personAct(box,box.repo,'bar','sign',String(agentItem),'--as','person','--note','I approve this agent-authored bar.'));
  const agentBar=JSON.parse(succeeds(personAct(box,box.repo,'bar',String(agentItem),'--json')).out);
  assert.equal(agentBar.signed.signerAuthority,'person');assert.equal(agentBar.signed.signerParent,null);
});
