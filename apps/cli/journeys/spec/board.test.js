/** The real CLI applies one spec batch from the board snapshot it commits. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  closeBoard,
  openBoard,
} from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 1, clause 2, clause 3: CLI spec apply handles seven rows under a peer writer and preserves untargeted frozen rows [C7]', { timeout: 120_000 }, async t => {
  const children = [];
  let stopPath;
  t.after(() => {
    if (stopPath) writeFileSync(stopPath, 'stop');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
  const sandbox = e2e.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'spec-apply-fixture';
  const box = e2e.project('true', sandbox, { withWorktree: false });
  const specPath = join(box.repo, 'SPEC.md');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.web.specs = Array.from({ length: 9 }, (_, index) => `G${index + 1}`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const sourceRows = Array.from({ length: 7 }, (_, index) => {
    const id = `G${index + 3}`;
    return `- ${id} [approved, must] Original ${id} promise. | gate: true`;
  }).join('\n');
  writeFileSync(specPath, `${readFileSync(specPath, 'utf8').trimEnd()}\n${sourceRows}\n`);
  commitFixtureFiles(box, ['pullboard.json', 'SPEC.md']);
  box.web = join(box.dir, 'web-1');
  box.git(box.repo, 'worktree', 'add', '-q', box.web, '-b', 'web/one');
  const joined = fixtureJoin(box.run, box.web, 'web', '--route', 'strong');
  assert.match(joined.out, /joined as web-1/u);

  const oldId = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Old frozen citation', route: 'strong',
    criterion: 'Keep prior G2 evidence while correcting G3.', diagnose: false,
    brief: 'Files: web/old-frozen-citation.js\nChange: keep the old citation\nTest: the check proves it',
    args: ['--specs', 'G2,G3'] }).item_id;
  const oldClaim = box.run(box.web, 'claim', String(oldId), '--json');
  assert.equal(oldClaim.code, 0, oldClaim.err || oldClaim.out);
  const priorItem = JSON.parse(box.run(box.web, 'show', String(oldId), '--json').out);
  const priorFrozen = JSON.parse(priorItem.item_frozen);
  assert.equal(priorFrozen.rows.find(row => row.id === 'G2').text, 'The API answers.');
  assert.equal(priorFrozen.rows.find(row => row.id === 'G3').text, 'Original G3 promise.');

  const peerId = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Peer claim during apply', route: 'strong',
    criterion: 'The peer keeps its assignment.', diagnose: false,
    brief: 'Files: web/peer-claim.js\nChange: keep the peer claim\nTest: the check proves it',
    args: ['--specs', 'G3'] }).item_id;
  const ids = Array.from({ length: 7 }, (_, index) => `G${index + 3}`);
  for (const id of ids) {
    const approved = box.run(box.repo, 'spec', 'approve', id, '--text', 'Updated promise text.', '--json');
    assert.equal(approved.code, 0, `approving ${id}: ${approved.err || approved.out}`);
  }

  const changedUnrelated = readFileSync(specPath, 'utf8').replace(
    '- G2 [approved, must] The API answers.', '- G2 [approved, must] Changed unrelated API promise.');
  assert.notEqual(changedUnrelated, readFileSync(specPath, 'utf8'));
  writeFileSync(specPath, changedUnrelated);

  const peerScript = join(box.dir, 'spec-apply-peer.mjs');
  const peerResultPath = join(box.dir, 'spec-apply-peer-result.json');
  writeFileSync(peerScript, [
    "import { watch, readFileSync, writeFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const [spec, result, bin, item] = process.argv.slice(2);',
    'let started = false;',
    'const run = () => {',
    '  if (started || !readFileSync(spec, "utf8").includes("Updated promise text.")) return;',
    '  started = true;',
    '  const child = spawnSync(process.execPath, [bin, "claim", item, "--json"], { encoding: "utf8" });',
    '  writeFileSync(result, JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }));',
    '  watcher.close();',
    '  process.exit(child.status === 0 ? 0 : 1);',
    '};',
    'const watcher = watch(spec, run);',
    'process.stdout.write("READY\\n");',
    'run();',
  ].join('\n'));
  const peer = startFixtureChild(process.execPath, [peerScript, specPath, peerResultPath,
    join(import.meta.dirname, '../../pullboard.js'), String(peerId)], { cwd: box.web, env: box.env });
  children.push(peer);
  const peerClosed = new Promise(resolve => peer.once('close', resolve));
  await new Promise((resolve, reject) => {
    let output = '';
    peer.stdout.setEncoding('utf8');
    peer.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY')) resolve();
    });
    peer.once('error', reject);
    peer.once('close', code => { if (code !== 0) reject(new Error(`peer exited before readiness: ${code}`)); });
  });

  stopPath = join(box.dir, 'stop-spec-apply-writer');
  const countPath = join(box.dir, 'spec-apply-writer-count');
  const writerScript = join(box.dir, 'spec-apply-writer.mjs');
  writeFileSync(writerScript, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    'const [boardFile, gitRoot, stop, countFile, storeUrl, appUrl] = process.argv.slice(2);',
    'const store = await import(storeUrl);',
    'const app = await import(appUrl);',
    'const board = app.openBoard(boardFile, undefined, { gitRoot });',
    'let count = 0;',
    'const step = () => {',
    '  if (Date.now() > deadline) { app.closeBoard(board); process.exitCode = 2; return; }',
    '  store.shout(board, { from: "web-1", to: "all", lanes: [], text: `spec apply peer progress ${count}` });',
    '  count += 1;',
    '  writeFileSync(countFile, String(count));',
    '  process.stdout.write(`COUNT ${count}\\n`);',
    '  const applied = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind = \'row_apply\'").get().id;',
    '  const latest = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind = \'shout\' AND event_by = \'web-1\'").get().id;',
    '  if (existsSync(stop) && applied && latest > applied) { app.closeBoard(board); process.stdout.write(`DONE ${count}\\n`); return; }',
    '  setImmediate(step);',
    '};',
    'const deadline = Date.now() + 20000;',
    'process.stdout.write("READY\\n");',
    'step();',
  ].join('\n'));
  const writer = startFixtureChild(process.execPath, [writerScript,
    join(box.repo, '.git', 'pullboard', 'board.sqlite'), box.repo, stopPath, countPath,
    pathToFileURL(join(import.meta.dirname, '../../../../packages/store/index.js')).href,
    pathToFileURL(join(import.meta.dirname, '../../../lib/src/logic/native.js')).href], { cwd: box.repo, env: box.env });
  children.push(writer);
  const writerClosed = new Promise(resolve => writer.once('close', resolve));
  let writerOutput = '';
  writer.stdout.setEncoding('utf8');
  writer.stdout.on('data', chunk => { writerOutput += chunk; });
  await e2e.waitFor(() => existsSync(countPath) && Number(readFileSync(countPath, 'utf8')) >= 2,
    'the peer writer to commit two events');
  const countBeforeApply = Number(readFileSync(countPath, 'utf8'));
  assert.ok(countBeforeApply >= 2);

  const apply = startFixtureChild(process.execPath, [join(import.meta.dirname, '../../pullboard.js'), 'spec', 'apply', '--json'],
    { cwd: box.repo, env: box.env });
  children.push(apply);
  let applyOut = '';
  let applyErr = '';
  apply.stdout.setEncoding('utf8');
  apply.stderr.setEncoding('utf8');
  apply.stdout.on('data', chunk => { applyOut += chunk; });
  apply.stderr.on('data', chunk => { applyErr += chunk; });
  const appliedExit = await new Promise(resolve => apply.once('close', resolve));
  assert.equal(appliedExit, 0, apply.fixtureFailure ?? `${applyOut}\n${applyErr}`);
  const result = JSON.parse(applyOut);
  assert.equal(result.applied.length, 7);
  for (const id of ids) assert.match(readFileSync(specPath, 'utf8'), new RegExp(`- ${id} \\[approved, must\\] Updated promise text\\.`));

  writeFileSync(stopPath, 'stop');
  const writerExit = await writerClosed;
  assert.equal(writerExit, 0, writer.fixtureFailure ?? writerOutput);
  assert.ok(Number(readFileSync(countPath, 'utf8')) > countBeforeApply, 'peer writer resumes and commits another event after spec apply');
  const peerExit = await peerClosed;
  assert.equal(peerExit, 0, peer.fixtureFailure ?? 'peer claim failed');
  const peerResult = JSON.parse(readFileSync(peerResultPath, 'utf8'));
  assert.equal(peerResult.status, 0, peerResult.stderr || peerResult.stdout);

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const events = store.events(board);
    const appliedEvent = events.find(event => event.event_kind === 'row_apply');
    const shoutRows = new Map(store.recentShouts(board, events.length + 1).map(shout => [shout.shout_id, shout.shout_text]));
    const shouts = events.filter(event => event.event_kind === 'shout'
      && shoutRows.get(JSON.parse(event.event_detail).shout)?.startsWith('spec apply peer progress '));
    assert.ok(appliedEvent, 'the actual CLI row_apply is recorded');
    assert.ok(shouts.some(event => event.event_id < appliedEvent.event_id), 'peer writer committed before the batch');
    assert.ok(shouts.some(event => event.event_id > appliedEvent.event_id), 'peer writer committed after the batch');
  } finally { closeBoard(board); }

  const peerItem = JSON.parse(box.run(box.web, 'show', String(peerId), '--json').out);
  assert.equal(peerItem.item_status, 'claimed');
  const oldAfter = JSON.parse(box.run(box.web, 'show', String(oldId), '--json').out);
  const frozen = JSON.parse(oldAfter.item_frozen);
  assert.equal(oldAfter.item_status, 'claimed');
  assert.equal(frozen.rows.find(row => row.id === 'G2').text, 'The API answers.');
  assert.equal(frozen.rows.find(row => row.id === 'G3').text, 'Updated promise text.');
});
