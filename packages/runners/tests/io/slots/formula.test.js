/** The runner slot formula and the gate's effective counts follow measured cores and memory [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESERVED_MEMORY_MB } from '../../../index.js';
import { PLAIN_SLOT_MB } from '../../../index.js';
import { BROWSER_SLOT_MB } from '../../../index.js';
import { computeRunnerSlots } from '../../../index.js';
import { effectiveRunners } from '../../../index.js';

const HOST = 'fixture-runner';

test('the formula leaves a core and 2 GB free and counts 512 MB per slot, 2 GB per browser slot [C7]', () => {
  assert.deepEqual(computeRunnerSlots({ cores: 10, memoryMB: 16384 }), { slots: 9, browser: 6 });
  assert.deepEqual(computeRunnerSlots({ cores: 2, memoryMB: 16384 }), { slots: 1, browser: 1 });
  assert.deepEqual(computeRunnerSlots({ cores: 32, memoryMB: 4096 }), { slots: 4, browser: 0 }, 'memory caps slots when cores are plentiful');
  assert.deepEqual(computeRunnerSlots({ cores: 4, memoryMB: 1024 }), { slots: 0, browser: 0 }, 'a starved runner offers no computed capacity below its memory reserve');
  const fleet = Array.from({ length: 6 }, () => computeRunnerSlots({ cores: 10, memoryMB: 16384 }).slots);
  assert.ok(fleet.reduce((a, b) => a + b) > 24, 'six 10-core 16 GB runners offer more than today\'s fixed 24');
});

test('the gate offers computed slots only when enabled, measured and not declared [C7]', () => {
  const measured = { host: 'a', slots: 4, browser: 2, cores: 10, memoryMB: 16384 };
  const fixed = { ...measured, host: 'b', fixed: true };
  const bare = { host: 'c', slots: 4, browser: 2 };
  assert.deepEqual(effectiveRunners({ runners: [measured, fixed, bare] }).map(r => r.slots), [4, 4, 4]);
  assert.deepEqual(effectiveRunners({ gate: { measuredSlots: true }, runners: [measured, fixed, bare] }).map(r => r.slots), [9, 4, 4]);
  assert.equal(effectiveRunners({ gate: { measuredSlots: true }, runners: [{ ...measured, browser: 0 }] })[0].browser, 0);
});

test('all computed mixtures fit their measured budget and inadequate or invalid observations never add capacity [C7]',()=>{
  for(const cores of [1,2,10,32])for(const memoryMB of [1024,2048,2560,4096,8192,16384]){
    const capacity=computeRunnerSlots({cores,memoryMB});
    for(let browser=0;browser<=capacity.browser;browser++){
      if(capacity.slots)assert.ok(RESERVED_MEMORY_MB+browser*BROWSER_SLOT_MB+(capacity.slots-browser)*PLAIN_SLOT_MB<=memoryMB);
    }
  }
  assert.deepEqual(effectiveRunners({gate:{measuredSlots:true},runners:[{host:HOST,slots:4,browser:2,cores:4,memoryMB:1024}]}),[]);
  for(const size of [{cores:0,memoryMB:16384},{cores:2,memoryMB:NaN},{cores:2.5,memoryMB:16384}])assert.throws(()=>computeRunnerSlots(size),TypeError);
});
