/** Real private native lifecycle journeys; assertions bind actual receipts before browser counts [N26]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import {
  join,
  dirname,
} from 'node:path';
import {
  project,
  build,
} from '../../harness.js';
import {
  intakeFixture,
  fixtureJSON,
} from '../../../intake.js';
import * as store from '../../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../../lib/index.js';

/** Observe genuine rare journeys and reject absent/non-native receipts before checking the live API.
 * Ports must run existing real CLI journeys, not return fabricated events or precomputed counts.
 * These are deliberately required: this helper cannot honestly conjure source ACCEPT or merge-only proof.
 */
export async function seedRareLifecycleJourneys({ board, journeys, readProject }) {
  const requirements = [
    ['rehome', ['rehome_import']],
    ['mergeOnly', ['merge-only-accept', 'submit']],
    ['intake', ['outside-intake']],
    ['patch', ['item_patch_attach']],
    ['verifiedPatch', ['item_patch_attach']],
    ['claimedPatch', ['claim', 'item_patch_attach', 'item_patch_remove', 'submit']],
    ['objected', ['item_patch_attach', 'item_patch_object']],
  ];
  const observed = {};
  for (const [name, kinds] of requirements) {
    assert.equal(typeof journeys[name], 'function', 'wire the existing real ' + name + ' journey');
    const before = store.events(board).at(-1)?.event_id ?? 0;
    console.log('PULLBOARD_LIFECYCLE_NATIVE ' + name);
    let id;
    try { id = await journeys[name](); }
    catch (error) { throw new Error(name + ': ' + error.message, { cause: error }); }
    assert.ok(Number.isSafeInteger(id) && id > 0, name + ' returns the actual destination item ID');
    const events = store.events(board, { itemId: id }).filter(event => event.event_id > before);
    for (const kind of kinds) assert.ok(events.some(event => event.event_kind === kind), name + ': actual ' + kind + ' event');
    observed[name] = { id, events };
  }
  const project = await readProject();
  for (const [verb, expected] of [['rehomeImport', 1], ['submit-merge', 1], ['intake', 1], ['patch', 2]]) {
    const total = Object.entries(project.moveCounts).filter(([key]) => key.endsWith(':' + verb)).reduce((sum, [, n]) => sum + n, 0);
    assert.equal(total, expected, 'actual native projected rare count: ' + verb);
  }
  assert.equal(project.moveCounts['claimed>claimed:patch-claimed'], 2, 'claimed attach and remove retain two actual self loops');
  const claimed = project.items.find(item => item.id === observed.claimedPatch.id);
  assert.ok(claimed, 'the exact claimed-patch item is in the live projection');
  assert.equal(claimed.status, 'submitted', 'the later real Submit is preserved');
  assert.equal(project.moveCounts['claimed>submitted:submit'] >= 1, true, 'claimed patches do not swallow the later Submit route');
  return observed;
}

/** Derive a stable readback fence over actual native receipts, never a fabricated proof. */
export function lifecycleReceiptFence(board) {
  return createHash('sha256').update(JSON.stringify(store.events(board))).digest('hex');
}

/** Wire concrete real private journeys; every Submit/ACCEPT below executes its ordinary CLI check.
 * The supplied target is the same cockpit project read by the later real Chrome assertions.
 * t owns intakeFixture cleanup; cockpit machine() owns the other projects and their temporary worktrees.
 */
export function nativeRareJourneys(t, { box, demo, readProject }) {
  assert.equal(typeof readProject, 'function', 'use the real authenticated full-state API');
  /** Read one ordinary native JSON result; no receipt/proof inputs are manufactured. */
  const json = (root, ...args) => JSON.parse(box.run(root, ...args, '--json'));
  /** Add a real native fixture item with an executable frozen check. */
  const add = (root, title, check = 'node --check web/lifecycle-fixture.js') => json(root, 'add', 'web', title, '--specs', 'G1',
    '--criterion', 'The fixture module parses.', '--check', check).item.item_id;
  /** Commit actual private source bytes through the existing fixture hooks. */
  const commit = (root, file, content, message) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
    box.git(root, 'add', file);
    box.git(root, 'commit', '-q', '-m', message + ' [G1]');
    return box.git(root, 'rev-parse', 'HEAD');
  };
  const reviewers = new Map();
  /** Keep the coordinator on main while a genuinely registered independent seat checks exact source. */
  const seatFor = (root, lane = 'web') => {
    const key = root + '\0' + lane;
    if (!reviewers.has(key)) reviewers.set(key, json(root, 'worktree', lane, '--model', 'Lifecycle reviewer fixture'));
    return reviewers.get(key);
  };
  const reviewerFor = root => seatFor(root).path;
  /** Independently verify from the submitted source through its registered native reviewer. */
  const accept = (root, id, head) => {
    const reviewer = reviewerFor(root);
    box.git(reviewer, 'switch', '-q', '--detach', head);
    json(reviewer, 'verify', String(id), 'accept', '--note',
      'The actual frozen fixture command passed.', '--no-next');
  };
  /** Generate exact native companion bytes from a clean private Git index, then restore that index. */
  const patchFile = (key, dir = 'docs') => {
    const file = dir + '/' + key + '.txt';
    assert.equal(box.git(demo.repo, 'status', '--porcelain'), '', 'the private author index starts clean');
    mkdirSync(join(demo.repo, dir), { recursive: true });
    writeFileSync(join(demo.repo, file), key + '\n');
    box.git(demo.repo, 'add', file);
    const bytes = box.git(demo.repo, 'diff', '--cached', '--binary') + '\n';
    box.git(demo.repo, 'reset', '-q', 'HEAD', '--', file);
    unlinkSync(join(demo.repo, file));
    const path = join(box.dir, key + '.patch');
    writeFileSync(path, bytes);
    return { path, bytes };
  };
  commit(demo.repo, 'web/lifecycle-fixture.js', 'export const fixture = true;\n', 'test(web): parse a real lifecycle fixture');
  box.git(demo.web, 'merge', '-q', '--no-edit', 'main');
  return {
    /** Import a genuinely ACCEPTed independent source, retaining its native source receipt. */
    rehome: async () => {
      const source = project(box, 'lifecycle-import-source');
      commit(source.repo, 'web/lifecycle-fixture.js', 'export const fixture = true;\n', 'test(web): parse imported lifecycle source');
      box.git(source.web, 'merge', '-q', '--no-edit', 'main');
      const id = add(source.repo, 'Accepted imported work');
      build(box, source, id, 'import-proof.txt');
      const head = box.git(source.web, 'rev-parse', 'HEAD');
      accept(source.repo, id, head);
      const from = openBoard(join(source.repo, '.git', 'pullboard', 'board.sqlite'));
      const to = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
      try {
        assert.equal(store.getItem(from, id).item_status, 'verified');
        const moveId = 'lifecycle-accepted-import';
        const destination = store.reserveRehomeItemId(to, store.boardId(from), moveId, { agentId: 'coordinator' });
        const record = store.rehomeItem(from, id, { agentId: 'coordinator', sourceMoveId: moveId,
          destinationBoardId: store.boardId(to), destinationItemId: destination });
        assert.ok(record.sourceReceipt.eventId > 0);
        store.applyRehomeItem(to, record, { destinationAgentId: 'coordinator' });
        assert.equal(store.getItem(to, destination).item_status, 'verified');
        return destination;
      } finally { store.closeBoard(from); store.closeBoard(to); }
    },
    /** Carry real review through a true merge conflict resolved and checked by the native Submit path. */
    mergeOnly: async () => {
      const file = 'web/lifecycle-choice.js';
      // Preserve the complete accepted configuration; only local landing publication is selected.
      const config = JSON.parse(readFileSync(join(demo.repo, 'pullboard.json'), 'utf8'));
      commit(demo.repo, 'pullboard.json', JSON.stringify({ ...config, landing: { ...config.landing, publish: 'separate' } }, null, 2), 'chore: configure private landing');
      commit(demo.repo, file, "export const choice = 'base';\n", 'feat(web): base lifecycle choice');
      box.git(demo.web, 'switch', '-q', demo.baseBranch);
      box.git(demo.web, 'merge', '-q', '--no-edit', 'main');
      const id = add(demo.repo, 'Keep an accepted merge choice', 'node --check ' + file);
      json(demo.web, 'claim', String(id));
      const accepted = commit(demo.web, file, "export const choice = 'accepted';\n", 'feat(web): accepted lifecycle choice');
      json(demo.web, 'submit', String(id), '--no-next');
      accept(demo.repo, id, accepted);
      commit(demo.repo, file, "export const choice = 'trunk';\n", 'feat(web): changed lifecycle trunk');
      json(demo.repo, 'reopen', String(id), '--conflict', file);
      json(demo.web, 'claim', String(id));
      // This is an intentional real Git conflict, checked without treating it as a command success.
      let conflicted = false;
      try { box.git(demo.web, 'merge', '-q', '--no-edit', 'main'); }
      catch { conflicted = box.git(demo.web, 'diff', '--name-only', '--diff-filter=U').split('\n').includes(file); }
      assert.equal(conflicted, true, 'the merge-only fixture must resolve its actual named conflict');
      commit(demo.web, file, "export const choice = 'resolved';\n", 'fix(web): resolve accepted lifecycle merge');
      json(demo.web, 'submit', String(id), '--no-next');
      const item = json(demo.repo, 'show', String(id));
      assert.equal(item.item_status, 'verified');
      return id;
    },
    /** Native intake reads a real private Git PR ref through the existing GET-only GitHub stand-in. */
    intake: async () => {
      const outside = intakeFixture(t);
      const intakeBefore = (await readProject()).moveCounts['open>submitted:intake'] ?? 0;
      // Its private GitHub facts describe a real Git object and local ref. No external HTTP or posts.
      box.git(demo.repo, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
      box.git(demo.repo, 'config', `url.file://${outside.origin}.insteadOf`, 'https://github.com/fixture/project.git');
      try {
        const filed = fixtureJSON(outside, demo.repo, 'intake', outside.pull.html_url, '--lane', 'web',
          '--route', 'strong', '--criterion', 'The contributed module parses.', '--check', 'node --check apps/relay/src/io/deploy/outside.js');
        const id = filed.item.item_id;
        assert.equal(filed.item.item_commit, outside.commit);
        assert.equal(filed.item.item_tree, outside.tree);
        assert.equal(filed.item.item_status, 'submitted');
        const intakeAfter = (await readProject()).moveCounts['open>submitted:intake'] ?? 0;
        assert.equal(intakeAfter - intakeBefore, 1, 'the real outside-intake receipt projects to its intake route');
        return id;
      } finally {
        box.git(demo.repo, 'remote', 'remove', 'origin');
        box.git(demo.repo, 'config', '--unset', `url.file://${outside.origin}.insteadOf`);
      }
    },
    /** Attach actual Git-generated companion bytes with native coordinator author/source binding. */
    patch: async () => {
      const id = add(demo.repo, 'Attach a native lifecycle companion');
      build(box, demo, id, 'patch-proof.txt');
      const head = box.git(demo.web, 'rev-parse', 'HEAD');
      const file = 'docs/lifecycle-companion.txt';
      assert.equal(box.git(demo.repo, 'status', '--porcelain'), '', 'patch author starts with a clean private index');
      mkdirSync(join(demo.repo, 'docs'), { recursive: true });
      writeFileSync(join(demo.repo, file), 'Native lifecycle companion.\n');
      box.git(demo.repo, 'add', file);
      const bytes = box.git(demo.repo, 'diff', '--cached', '--binary') + '\n';
      box.git(demo.repo, 'reset', '-q', 'HEAD', '--', file);
      unlinkSync(join(demo.repo, file));
      const path = join(box.dir, 'lifecycle-companion.patch');
      writeFileSync(path, bytes);
      json(demo.repo, 'patch', 'attach', String(id), path, '--key', 'lifecycle-route', '--author', 'coordinator', '--source', head);
      const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
      try {
        assert.equal(store.itemPatches(board, id)[0].patch, bytes);
        assert.equal(store.itemPatches(board, id)[0].commit, head);
      } finally { store.closeBoard(board); }
      return id;
    },
    /** Invalidate an actual independent ACCEPT through the distinct Verified-to-In-review patch route. */
    verifiedPatch: async () => {
      const id = add(demo.repo, 'Update genuinely verified work');
      build(box, demo, id, 'verified-patch-proof.txt');
      const head = box.git(demo.web, 'rev-parse', 'HEAD');
      accept(demo.repo, id, head);
      assert.equal(json(demo.repo, 'show', String(id)).item_status, 'verified');
      const patch = patchFile('verified-lifecycle-companion');
      json(demo.repo, 'patch', 'attach', String(id), patch.path, '--key', 'verified-lifecycle-route',
        '--author', 'coordinator', '--source', head);
      assert.equal(json(demo.repo, 'show', String(id)).item_status, 'submitted');
      return id;
    },
    /** Attach and remove within the same genuine claim, then run the ordinary exact-source Submit. */
    claimedPatch: async () => {
      const id = add(demo.repo, 'Update while building then submit');
      box.git(demo.web, 'switch', '-q', demo.baseBranch);
      json(demo.web, 'claim', String(id));
      const head = commit(demo.web, 'web/claimed-patch-proof.js', 'export const claimed = true;\n',
        'feat(web): real claimed companion source');
      const before = json(demo.repo, 'show', String(id));
      const countsBefore = (await readProject()).moveCounts;
      const patch = patchFile('claimed-lifecycle-companion');
      json(demo.repo, 'patch', 'attach', String(id), patch.path, '--key', 'claimed-lifecycle-route',
        '--author', 'coordinator', '--source', head);
      const attached = json(demo.repo, 'show', String(id));
      json(demo.repo, 'patch', 'remove', String(id), 'claimed-lifecycle-route');
      const removed = json(demo.repo, 'show', String(id));
      for (const actual of [attached, removed]) {
        assert.equal(actual.item_status, 'claimed');
        assert.equal(actual.item_owner, before.item_owner);
        assert.equal(actual.item_lease_until, before.item_lease_until);
        assert.equal(actual.item_frozen_digest, before.item_frozen_digest);
      }
      json(demo.web, 'submit', String(id), '--no-next');
      const submitted = json(demo.repo, 'show', String(id));
      assert.equal(submitted.item_status, 'submitted');
      assert.equal(submitted.item_commit, head);
      const countsAfter = (await readProject()).moveCounts;
      for (const [key, delta] of [['claimed>claimed:patch-claimed', 2], ['claimed>submitted:submit', 1], ['claimed>submitted:patch', 0]]) {
        assert.equal((countsAfter[key] ?? 0) - (countsBefore[key] ?? 0), delta, 'native claimed-patch journey exact delta: ' + key);
      }
      return id;
    },
    /** The owning lane objects inside the window to a companion the builder recorded at Submit, reopening the item. */
    objected: async () => {
      const id = add(demo.repo, 'Owner objects to a recorded companion');
      box.git(demo.web, 'switch', '-q', demo.baseBranch);
      json(demo.web, 'claim', String(id));
      commit(demo.web, 'web/objected-proof.js', 'export const objected = true;\n', 'feat(web): real objected companion source');
      const owner = seatFor(demo.repo, 'api');
      const patch = patchFile('objected-lifecycle-companion', 'api');
      json(demo.web, 'submit', String(id), '--companion', patch.path, '--key', 'objected-lifecycle-route',
        '--author', owner.agent, '--wait', '--no-next');
      assert.equal(json(demo.repo, 'show', String(id)).item_status, 'submitted');
      json(owner.path, 'patch', 'object', String(id), 'objected-lifecycle-route', '--note', 'The owning lane needs a different interface.');
      assert.equal(json(demo.repo, 'show', String(id)).item_status, 'open');
      return id;
    },
  };
}
