/** next.idleBlockers makes an empty next name the waiting items and what each waits on, and is off by default [C7,N2,#2958]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Write this fixture machine's next settings, keeping the settings the fixture wrote. */
function nextSettings(next) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next }));
}

/** One claimed blocker held by another seat and `count` open items that each wait on it, so the actor seat has nothing free. */
function waiting(box, count = 4) {
  const blocker = box.add('Blocker built by another seat');
  box.claim(blocker);
  const followers = Array.from({ length: count }, (_, index) => box.add(`Follower ${index + 1}`, { after: [blocker] }));
  return { blocker, followers };
}

/** The actor seat's human answer to an empty next --take, with its stdout and stderr in print order. */
async function idleAnswer(box) {
  const lines = [];
  const code = await main(['next', '--take'], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { lines.push(part); } },
    stderr: { write: part => { lines.push(part); } } });
  return { code, text: lines.join('') };
}

test('clause 1: with next.idleBlockers on, an empty next --take prints three blocker lines naming an item and what it waits on [C7,N2,#2958]', async t => {
  const box = await fixture(t);
  const { blocker, followers } = waiting(box);
  nextSettings({ idleBlockers: true });
  const answer = await idleAnswer(box);
  assert.equal(answer.code, 1, answer.text);
  assert.match(answer.text, /\[NOTHING_FREE\]/u, 'the idle line is still printed');
  const lines = answer.text.split(/\r?\n/u).filter(line => line.startsWith('blocked: '));
  assert.equal(lines.length, 3, 'four waiting items give three blocker lines');
  for (const line of lines) {
    const [, item, waitsOn] = /^blocked: #(\d+) waits on #(\d+)$/u.exec(line) ?? [];
    assert.ok(followers.includes(Number(item)), `${line} names a waiting item`);
    assert.equal(Number(waitsOn), blocker, `${line} names the unverified item it waits on`);
  }
  assert.ok(answer.text.indexOf('[NOTHING_FREE]') < answer.text.indexOf('blocked: '), 'the blocker lines follow the idle line');
});

test('clause 2: the next-idle event that call recorded names the same item ids in its skips [C7,N2,#2958]', async t => {
  const box = await fixture(t);
  const { followers } = waiting(box);
  nextSettings({ idleBlockers: true });
  const answer = await idleAnswer(box);
  const printed = [...answer.text.matchAll(/^blocked: #(\d+) waits on/gmu)].map(match => Number(match[1])).sort((a, b) => a - b);
  const idle = store.events(box.board).filter(event => event.event_by === box.seats.actor.id && event.event_kind === 'next-idle').at(-1);
  assert.ok(idle, 'the empty next recorded a next-idle event');
  const skipped = JSON.parse(idle.event_detail).skips.map(row => row.item).sort((a, b) => a - b);
  assert.deepEqual(printed, skipped, 'the printed ids are the recorded skips');
  assert.ok(printed.every(id => followers.includes(id)));
});

test('clause 3: with next.idleBlockers off, the default, an empty next prints no blocker line [C7,N2,#2958]', async t => {
  const box = await fixture(t);
  waiting(box);
  const unset = await idleAnswer(box);
  assert.equal(unset.code, 1, unset.text);
  assert.match(unset.text, /\[NOTHING_FREE\]/u);
  assert.doesNotMatch(unset.text, /blocked: /u, 'the default answer is unchanged');
  nextSettings({ idleBlockers: false });
  const off = await idleAnswer(box);
  assert.doesNotMatch(off.text, /blocked: /u, 'an explicit false is the same as unset');
});
