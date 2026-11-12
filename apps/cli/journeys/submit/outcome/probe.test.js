/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Temporary timing probe for the submit outcome journey [V4,B3,H16]. */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { remote } from '../../../tests/fixtures/submit/outcome.js';

const sh = (cmd) => { try { return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 20000 }).replace(/\n/g, ' ; ').slice(0, 1500); } catch (e) { return 'fail ' + e.message.slice(0, 100); } };

test('probe stage timings [V4,B3,H16]', async t => {
  const t0 = Date.now();
  const mark = label => console.log(`# PROBE ${label} ${Date.now() - t0}ms`);
  const box = await fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
  await remote(box);
  const pending = cliAsync(box, box.builder, 'submit', String(box.item));
  const pid = pending.child.pid;
  pending.child.stderr.on('data', d => mark('ERR ' + String(d).slice(0, 300)));
  for (const at of []) setTimeout(() => {
    mark('LSOF ' + sh(`lsof -p ${pid} 2>/dev/null | awk '{print $4, $9}' | grep -v "txt\\|cwd\\|rtd\\|KQUEUE\\|PIPE\\|^0\\|^1\\|^2" | tail -15`));
    mark('MACHINE ' + sh(`ls -la ${box.env.PULLBOARD_MACHINE_HOME} | tail -12; cat ${box.env.PULLBOARD_MACHINE_HOME}/settings.json`));
    mark('SAMPLE ' + sh(`sample ${pid} 1 -file /dev/stdout 2>&1 | grep -E "^\\s+[0-9]+ [A-Za-z_]" | head -12`));
  }, at);
  const result = await pending;
  mark('submit status ' + result.status + ' ' + result.stdout.slice(0, 200));
});
