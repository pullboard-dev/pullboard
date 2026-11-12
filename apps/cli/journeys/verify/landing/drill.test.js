/** @pullboard-test-loads apps/cli/tests/fixtures/landing/loader.js */
/** Kill actual workers, retaining real Git and SQLite state for the next native accept [B35]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../../tests/fixtures/child.js';
import { waitForFixtureProgress } from '../../../tests/fixtures/progress.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { getItem } from '../../../../../packages/store/index.js';
import { landingBatches } from '../../../../../packages/store/index.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';

/** Commit fixture inputs through ordinary hooks. */
function commit(box, root, subject) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', subject);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Prepare two independent submitted heads before the first acceptance can move main. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: 'true', landing: { manualOverride: false } }));
  commit(box, box.repo, 'chore: configure automatic crash recovery');
  const remote = join(box.dir, 'remote.git');
  box.git(box.repo, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const api = join(box.dir, 'api-builder');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/crash');
  json(box, api, 'join', 'api');
  const entries = [[box.web, 'web', 'G1'], [api, 'api', 'G2']].map(([root, lane, spec]) => {
    const file = `${lane}/crash.txt`;
    const id = json(box, box.repo, 'add', lane, 'Crash drill ' + lane, '--route', 'mid',
      '--criterion', file + ' exists', '--specs', spec, '--check', 'test -f ' + file,
      '--brief', `Files: ${file}\nChange: create a fixture payload for the interrupted landing.\nTest: the accepted payload lands after the interrupted batch resumes.`).item.item_id;
    json(box, root, 'claim', String(id));
    mkdirSync(join(root, lane), { recursive: true });
    writeFileSync(join(root, file), lane + '\n');
    const head = commit(box, root, `feat(${lane}): crash drill input [${spec}]`);
    json(box, root, 'submit', String(id));
    return { id, head, file, lane };
  });
  // Main moves after both submits, so no submit receipt answers for a landing tree and each landing gate really runs [C7].
  writeFileSync(join(box.repo, 'main-moved-after-submit.txt'), 'main moved after the submits\n');
  commit(box, box.repo, 'chore: move main after the submits');
  const reviewer = join(box.dir, 'crash-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, entries[0].head);
  json(box, reviewer, 'join', 'api', '--model', FIXTURE_MODEL, '--route', 'strong');
  return { box, entries, reviewer, remote };
}

/** Kill only the worker PID named by the injected boundary in this fixture's own private subprocess. */
async function crash(t, box, reviewer, id, stage) {
  const marker = join(box.dir, stage + '-worker.json');
  const loader = new URL('../../../tests/fixtures/landing/loader.js', import.meta.url).href;
  const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
  const child = startFixtureChild(process.execPath, [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)),
    'verify', String(id), 'accept', '--note', 'Read actual fixture source and frozen check.', '--json'], {
    cwd: reviewer, env: { ...box.env, NODE_OPTIONS: [box.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      PULLBOARD_PRIVATE_CRASH_STAGE: stage, PULLBOARD_PRIVATE_CRASH_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let workerKilled = false;
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (!workerKilled && existsSync(marker)) {
      const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  await waitForFixtureProgress({ child, ready: () => existsSync(marker), progress: () => output.length, description: 'landing reaches ' + stage + ' ' + JSON.stringify(output) });
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(owner.stage, stage);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid);
  const before = onBoard(box, board => landingBatches(board).at(-1));
  assert.ok(before && before.state !== 'landed', 'a durable unfinished batch precedes the real kill');
  process.kill(owner.pid, 'SIGKILL');
  workerKilled = true;
  // Landing runs inside the accepting command's own process (f226542983), so the kill ends that command; the
  // recorded verdict is what survives it.
  const [code, signal] = await closed;
  assert.equal(signal, 'SIGKILL', 'the killed process was the landing: ' + JSON.stringify({ code, output }));
  assert.equal(onBoard(box, board => getItem(board, id).item_status), 'verified', 'the verdict survives the killed landing');
  return before.id;
}

for (const stage of ['merging', 'gating', 'pushing', 'recording']) {
  test(`killing the landing worker during ${stage} lets the next accept land both items without manual recovery [B35]`, async t => {
    const { box, entries, reviewer, remote } = fixture(t);
    const batch = await crash(t, box, reviewer, entries[0].id, stage);
    assert.equal(json(box, box.repo, 'show', String(entries[0].id)).item_merged_commit, null);
    box.git(reviewer, 'checkout', '-q', '--detach', entries[1].head);
    const secondAccept = await box.runIn(reviewer, 'verify', String(entries[1].id), 'accept', '--note', 'Read second independent fixture head and frozen check.', '--json');
    assert.equal(secondAccept.code, 0, `${secondAccept.err}\n${secondAccept.out}`);
    const acceptance = JSON.parse(secondAccept.out);
    await waitForCondition(() => onBoard(box, board => entries.every(entry => getItem(board, entry.id)?.item_merged_commit)),
      `the recovered ${stage} landing records both accepted items`, {
        signal: AbortSignal.timeout(180_000),
        state: () => onBoard(box, board => entries.map(entry => ({ id: entry.id, status: getItem(board, entry.id)?.item_status,
          merged: getItem(board, entry.id)?.item_merged_commit }))),
      });
    for (const entry of entries) {
      const item = json(box, box.repo, 'show', String(entry.id));
      assert.ok(item.item_merged_commit,
        `native merged receipt exists for ${entry.id} after accept ${JSON.stringify(acceptance)}; stderr: ${secondAccept.err}`);
      box.git(box.repo, 'merge-base', '--is-ancestor', entry.head, 'main');
      assert.equal(readFileSync(join(box.repo, entry.file), 'utf8'), entry.lane + '\n');
    }
    assert.equal(onBoard(box, board => landingBatches(board).find(row => row.id === batch).state), 'landed', 'the interrupted batch resumes');
    assert.equal(box.git(remote, 'rev-parse', 'refs/heads/main'), box.git(box.repo, 'rev-parse', 'main'), 'real remote and local main agree');
  });
}
