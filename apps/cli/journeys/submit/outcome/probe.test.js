/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Temporary timing probe for the submit outcome journey [V4,B3,H16]. */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { remote } from '../../../tests/fixtures/submit/outcome.js';

function tree(root) {
  const rows = execFileSync('ps', ['-axo', 'pid,ppid,etime,command']).toString().split('\n').slice(1).map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
  const keep = new Set([String(root)]);
  let grew = true;
  while (grew) { grew = false; for (const r of rows) if (keep.has(r[2]) && !keep.has(r[1])) { keep.add(r[1]); grew = true; } }
  return rows.filter(r => keep.has(r[1])).map(r => `${r[3]} ${r[4].replace(/\/Users\/coreyolson\/\.nvm\/versions\/node\/v[\d.]+\/bin\//, '').slice(0, 170)}`).join(' || ');
}

test('probe stage timings [V4,B3,H16]', async t => {
  const t0 = Date.now();
  const mark = label => console.log(`# PROBE ${label} ${Date.now() - t0}ms`);
  const box = await fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
  mark('fixture');
  await remote(box);
  mark('remote');
  const pending = cliAsync(box, box.builder, 'submit', String(box.item));
  const pid = pending.child.pid;
  for (const at of [15000, 40000, 80000, 120000, 150000]) setTimeout(() => mark('TREE ' + tree(pid)), at);
  const result = await pending;
  mark('submit status ' + result.status + ' ' + result.stdout.slice(0, 200));
});
