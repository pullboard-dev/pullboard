/** @pullboard-test-input apps/cli/pullboard.js packages/gate/src/io/run/tests.js packages/kernel/index.js packages/kernel/src/logic/census.js packages/resources/index.js */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureProjectPolicy } from '../../../tests/fixtures/testkit.js';
import {
  fixtureGate,
  git,
  fixture,
  scenario,
  landingGate,
  marks,
} from '../../../tests/fixtures/init/shards.js';

for (const count of [1, 3]) test(`collect-all retains two real failures and later green files with ${count} shard(s) [C7,V4]`, { timeout: 90_000 }, async t => {
  const box=fixture({runner:false});
  t.after(()=>rmSync(box.dir,{recursive:true,force:true}));
  fixtureProjectPolicy(box.repo, { config: { gate: fixtureGate(), landingShards: count } });
  if(git(box.repo,box.env,'status','--porcelain','pullboard.json').trim()) {
    git(box.repo,box.env,'add','pullboard.json');git(box.repo,box.env,'commit','-q','-m','test: collect-all shard count');
  }
  box.collectAll=true;
  scenario(box,'collect-all');
  const result=await landingGate(box,`collect both reds ${count}`,60_000);
  assert.equal(result.isGreen,false,'complete collection never turns red green');
  assert.equal(result.collectAllComplete,true,'actual native runner reports all planned files complete despite both failures');
  for(const name of ['a','b']) {
    assert.match(result.output,new RegExp(`not ok[^\\n]*fixture file ${name}`,'u'),result.output);
    assert.match(result.output,new RegExp(`collect-all deliberate failure ${name}`,'u'),result.output);
    assert.match(result.output,new RegExp(`test/${name}\\.test\\.js`,'u'),result.output);
  }
  assert.deepEqual(marks(box,'.finished').map(name=>name.split('.')[0]).sort(),['c','d','e','f'],
    'later green bodies actually finish; neither an abort nor omitted body counts as collected');
  assert.doesNotMatch(result.output,/Landing gate stopped early|attempt \d+ on \S+: stopped/u);
  if(count>1) {
    assert.equal(result.profile.landingShards.shards.some(row=>row.status==='stopped'),false);
    assert.equal(result.profile.landingShards.files.length,6);
  }
});
