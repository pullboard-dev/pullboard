import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import { commitCandidate } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const log = (...a) => process.stderr.write(`[${(performance.now()/1000).toFixed(1)}s] ${a.join(' ')}\n`);
const handles = () => process._getActiveHandles().map(h => h.constructor.name + (h.spawnfile ? `(${h.spawnfile} ${(h.spawnargs||[]).slice(1,3).join(' ').slice(0,80)} pid ${h.pid})` : '')).join(', ');
test('repro [C7]', async t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const inproc = async (cwd, ...args) => { const r = await runCliInProcess([...args, '--json'], { cwd, env: box.env }); return { code: r.status, document: r.stdout.trim() ? JSON.parse(r.stdout) : null, r }; };
  log('claim'); let r = await inproc(builder.root, 'claim', String(id)); assert.equal(r.code, 0);
  commitCandidate(builder, 'chore: x');
  log('submit'); r = await inproc(builder.root, 'submit', String(id)); log('submitted', r.code); log('handles', handles());
  const head = box.cli('show', String(id)).document.item_commit;
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  log('verify'); r = await inproc(reviewer.root, 'verify', String(id), 'accept'); log('verified', r.code); log('handles', handles());
  setTimeout(() => log('handles+5s', handles()), 5000).unref();
});
