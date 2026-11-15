/** Shared kit for the reopen conflict-cause journeys: a real board with two conflicting submissions and the bytes of its reopen [C7,B3]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { eventCauses } from '../../../../../packages/store/index.js';
import { joinFixtureSeat } from '../testkit.js';
import { verifySettled } from '../submit/settle.js';

/** Bind the kit to one test file's e2e helpers, which own its sandboxes and their cleanup, and to the merge cell's trunkMerge it hands in. */
export function causeKit(helpers, { trunkMerge } = {}) {
  const FILE = 'web/shared.js';
  const SECOND = 'web/other.js';

  /** Assert a fixture command succeeded before using its structured receipt. */
  async function json(box, path, ...args) {
    const result = (await box.runLocal(path, ...args, '--json'));
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out);
  }

  /** Create a local-only real board and a shared Git base without changing the person's storage. */
  function project(separate = true) {
    const box = helpers.project('true');
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, ...(separate ? { landing: { perItem: false, manualOverride: true, publish: 'separate' } } : {}) }));
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    for (const path of [FILE, SECOND]) writeFileSync(join(box.repo, path), 'export const value = "base";\n');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: establish conflict fixture base');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    if (!separate) {
      const remote = join(box.dir, 'private-origin.git');
      box.git(box.dir, 'init', '-q', '--bare', remote);
      box.git(box.repo, 'remote', 'add', 'origin', remote);
      box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
    }
    return box;
  }

  /** Submit a genuine branch changing both files, optionally using another joined lane seat. */
  async function submit(box, number = 1) {
    const path = number === 1 ? box.web : join(box.dir, 'builder-' + number);
    if (number !== 1) {
      box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/conflict-' + number, path, 'main');
      const joined = joinFixtureSeat(box, path, 'web');
      assert.equal(joined.code, 0, joined.out + joined.err);
    }
    const added = (await json(box, box.repo, 'add', 'web', 'Conflict fixture ' + number, '--specs', 'G1',
      '--criterion', 'Both modules remain valid.', '--check', 'node --check ' + FILE, '--accept-green', 'fixture check keeps passing'));
    const id = added.item.item_id;
    (await json(box, path, 'claim', String(id)));
    for (const file of [FILE, SECOND]) writeFileSync(join(path, file), `export const value = "item-${number}";\n`);
    box.git(path, 'add', FILE, SECOND);
    box.git(path, 'commit', '-q', '-m', 'feat(web): build conflict fixture [G1]');
    const commit = box.git(path, 'rev-parse', 'HEAD');
    (await json(box, path, 'submit', String(id)));
    return { id, path, commit };
  }

  /** Independently check the private fixture submission before restoring its main checkout. */
  async function accept(box, entry) {
    box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
    // The pulled gate's receipt lands just after its job reads done; verify again until the item has left claimed [C7,#7283].
    try {
      const verdict = await verifySettled(box, box.runLocal, box.repo, ['verify', String(entry.id), 'accept', '--as', 'coordinator', '--note', 'Both modules parse at the exact submitted commit.', '--json']);
      assert.equal(verdict.code, 0, verdict.out + verdict.err);
    }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
  }

  /** Move main into a real conflict, and obtain the exact file list independently from Git. */
  function conflict(box, entry) {
    for (const file of [FILE, SECOND]) writeFileSync(join(box.repo, file), 'export const value = "main";\n');
    box.git(box.repo, 'add', FILE, SECOND);
    box.git(box.repo, 'commit', '-q', '-m', 'chore: move the conflict fixture trunk');
    const merge = trunkMerge(box.repo, entry.commit);
    assert.deepEqual([...merge.files].sort(), [FILE, SECOND].sort(), 'Git establishes both conflicts');
    return merge;
  }

  /** Inspect original durable event bytes rather than trusting the command's completion message. */
  function latest(box, id) {
    // @pullboard-board-file persistence: inspect the reopen event bytes committed by the separate native CLI command
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try {
      const row = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='reopen' ORDER BY event_id DESC LIMIT 1").get(id);
      assert.ok(row, 'a real reopen was appended');
      return { row, detail: JSON.parse(row.event_detail), item: store.getItem(board, id) };
    } finally { store.closeBoard(board); }
  }

  /** Every newly recorded conflict names all Git files and excludes even an explicitly supplied test cause. */
  function assertConflict(record, files) {
    assert.equal(record.item.item_status, 'open');
    assert.ok(record.detail.conflict, 'the reopen carries structured conflict evidence');
    assert.ok(record.detail.causeDerivation, 'the reopen carries structured cause provenance');
    assert.deepEqual([...record.detail.conflict.files].sort(), [...files].sort());
    assert.deepEqual([...record.detail.causeDerivation.files].sort(), [...files].sort());
    assert.ok(record.detail.cause.startsWith('conflict:'));
    assert.ok(eventCauses(record.row).every(key => key.startsWith('conflict:')));
    assert.deepEqual(eventCauses(record.row).sort(), files.map(file => 'conflict:' + encodeURI(file)).sort());
    assert.equal(record.detail.landingFailure, undefined, 'a conflict is never recorded as a failed test');
  }

  return { FILE, SECOND, json, project, submit, accept, conflict, latest, assertConflict };
}
