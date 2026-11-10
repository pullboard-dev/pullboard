/** @pullboard-test-loads apps/cli/src/io/commands/join.js apps/cli/src/io/item/folder/identity.js */
/** Join refuses inside an item folder, so a stray seat never owns work that maintenance can remove [C7]. */
import { joinFixtureSeat } from '../../testkit.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../e2e.js';

/** Register the item-folder join refusal when the owning maintenance suite imports this fixture. */
export function registerMaintenanceJoinTests() {
  test('clause 2: join refuses with JOIN_IN_ITEM_FOLDER inside an item folder and names the lane worktree to join from [C7]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    const seat = join(box.dir, 'join-seat'), folder = join(box.dir, 'join-seat-item-7');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
    assert.equal(joinFixtureSeat(box, seat, 'web').code, 0, 'a lane worktree still joins');
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/item-7', folder, 'main');

    const refused = joinFixtureSeat(box, folder, 'web');
    assert.equal(refused.code, 1);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'JOIN_IN_ITEM_FOLDER');
    assert.ok(error.message.includes(seat), 'the refusal names the lane worktree to run from');
    const agents = box.run(box.repo, 'agents', '--json');
    assert.equal((agents.out.match(/join-seat-item-7/gu) ?? []).length, 0, 'no seat was registered in the item folder');
  });
}
