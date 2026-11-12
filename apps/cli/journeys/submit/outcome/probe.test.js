/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Temporary timing probe for the submit outcome journey [V4,B3,H16]. */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { remote } from '../../../tests/fixtures/submit/outcome.js';


test('probe stage timings [V4,B3,H16]', async t => {
  const t0 = Date.now();
  const mark = label => console.log(`# PROBE ${label} ${Date.now() - t0}ms`);
  const timer = setTimeout(() => { mark('STILL RUNNING'); }, 100000);
  const box = await fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
  mark('fixture');
  await remote(box);
  mark('remote');
  setTimeout(() => { try { console.log('# PROBE PS ' + execFileSync('ps', ['-axo', 'pid,ppid,etime,command']).toString().split('\n').filter(l => l.includes('pullboard') || l.includes('node ')).map(l => l.slice(0, 260)).join(' || ')); } catch (e) { console.log('# PROBE psfail ' + e.message); } }, 50000);
  const result = await cliAsync(box, box.builder, 'submit', String(box.item));
  mark('submit status ' + result.status + ' ' + result.stdout.slice(0, 300));
  clearTimeout(timer);
});
