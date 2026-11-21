/** Typed item conversations use the real CLI, Git, SQLite and runner pack [B29,B30,B31,B32,N14,N26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from "../../../../../../packages/store/index.js";
import { createE2eHelpers } from "../../../fixtures/e2e.js";
import { waitForState } from "../../../fixtures/check-baseline.js";
import { onBoard } from "../../../fixtures/land/board.js";

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Keep every public command's failure beside the assertion that needs its result. */
async function command(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.out}\n${result.err}`);
  return result;
}

/** Read the CLI's actual JSON projection rather than constructing an expected thread. */
async function document(box, cwd, ...args) {
  return JSON.parse((await command(box, cwd, ...args, '--json')).out);
}

/** Append a public fact with its original text, author, timestamp and stable identity. */
async function note(box, cwd, item, kind, text) {
  const fact = (await document(box, cwd, 'fact', String(item), kind, text)).fact;
  assert.equal(fact.kind, kind);
  assert.equal(fact.text, text);
  assert.ok(fact.id);
  assert.ok(fact.at);
  assert.ok(fact.by);
  return fact;
}

test('cli.journeys-fact-item-notes.typed-notes-on-an-item-reach: typed notes on an item reach its agents and stay off the board-wide feed [B29,B30,B31,B32,N14,N26]', async () => {
  const box = helpers.project();
  const reviewer = join(box.dir, 'notes-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  await command(box, reviewer, 'join', 'web', '--model', 'fixture-model', '--route', 'strong', '--parent', 'notes-reviewer-parent');
  const added = await document(box, box.repo, 'add', 'web', 'Read the item conversation', '--specs', 'G1',
    '--route', 'strong', '--criterion', 'the page exists', '--check', 'test -f web/page.js',
    '--brief', helpers.LIGHT_BRIEF, '--wait');
  const id = added.item.item_id;
  const other = (await document(box, box.repo, 'add', 'api', 'An unrelated conversation', '--specs', 'G2',
    '--criterion', 'no item conversation leaks', '--check', 'true', '--wait')).item.item_id;
  await command(box, box.web, 'claim', String(id));
  const before = onBoard(box, board => store.allShouts(board));
  const notes = [
    await note(box, box.web, id, 'bar-check', 'bar: the page exists\nedge cases: an empty page is allowed\ntest: the real file exists'),
    await note(box, box.web, id, 'question', 'Does <text> retain its exact bytes?\nThis is a second line.'),
    await note(box, reviewer, id, 'answer', 'Yes, preserve the exact bytes; this is not a person approval.'),
    await note(box, box.web, id, 'plan', 'Read this thread before changing web/page.js.'),
    await note(box, reviewer, id, 'risk', 'A board-wide shout would disclose unrelated item conversation.'),
  ];
  await note(box, reviewer, other, 'risk', 'OTHER-ITEM-ONLY: do not put this in the first item pack.');
  assert.deepEqual(onBoard(box, board => store.allShouts(board)), before,
    'posting the conversation creates no shout or board-wide delivery');
  for (const path of [box.web, reviewer]) {
    const thread = (await document(box, path, 'show', String(id))).thread.filter(entry => entry.type === 'fact');
    assert.deepEqual(thread.map(({ id, kind, text, by, at }) => ({ id, kind, text, by, at })),
      notes.map(({ id, kind, text, by, at }) => ({ id, kind, text, by, at })));
  }
  assert.equal(onBoard(box, board => store.openDecisions(board).length), 0,
    'an observational question and answer do not become an approval decision');
  await command(box, box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'Run the item with its recorded notes.', '--no-next');
  const captured = join(box.dir, 'actual-context-pack.md');
  const script = join(box.dir, 'read-pack.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(captured)}, fs.readFileSync(process.env.PULLBOARD_PACK));`,
    "fs.mkdirSync('web', { recursive: true }); fs.writeFileSync('web/page.js', 'PASS\\n');",
  ].join('\n'));
  const ran = await command(box, box.web, 'run', '--agent-strong', `"${process.execPath}" "${script}"`,
    '--attempts', '1', '--items', '1');
  assert.match(ran.out, new RegExp(`#${id} is in the gate`));
  const pack = readFileSync(captured, 'utf8');
  for (const fact of notes) {
    assert.ok(pack.includes(fact.text), `${fact.kind} text reaches the actual run pack`);
    assert.ok(pack.includes(fact.id), `${fact.kind} identity reaches the actual run pack`);
    assert.ok(pack.includes(fact.by), `${fact.kind} author reaches the actual run pack`);
  }
  assert.ok(!pack.includes('OTHER-ITEM-ONLY'), 'the pack reads only this item conversation');
  // The fixture's loopback runner pulls the gate job and `run` returns once it settles, and the real gate submits the item when its receipt posts.
  await waitForState(() => onBoard(box, board => store.getItem(board, id).item_status) === 'submitted', 'the pulled gate submits the item once its receipt posts');
  const held = await document(box, reviewer, 'next', '--verify', String(id));
  assert.equal(held.item.item_id, id, 'the independent reviewer really reserves the submitted item');
  assert.deepEqual((await document(box, reviewer, 'show', String(id))).thread.filter(entry => entry.type === 'fact'),
    (await document(box, box.web, 'show', String(id))).thread.filter(entry => entry.type === 'fact'));
  await command(box, box.repo, 'shout', 'all', 'A real board-wide release is ready.');
  const feed = onBoard(box, board => store.allShouts(board));
  assert.ok(feed.some(row => row.shout_text === 'A real board-wide release is ready.'), 'board news still reaches its feed');
  for (const fact of notes) assert.ok(!feed.some(row => row.shout_text.includes(fact.text)), 'item notes never become shouts');
});
