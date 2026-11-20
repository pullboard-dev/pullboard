/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import {
  assert,
  helpers,
  rmSync,
  run,
  store,
  test,
  withBoard,
  writeFileSync,
} from '../../../tests/fixtures/scenarios/team.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run one CLI call the way the journey does (in-process, or a real process under PULLBOARD_JOURNEY_MODE=process) and return its output. */
async function go(box, root, ...args) {
  const result = await box.runIn(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}

test('cli.journeys-verify-team-repair.a-checkout-or-trunk-moving-during: clause 1: a checkout or trunk moving during verification cannot acquire proof [E8]', async () => {
  const box = helpers.project();
  // The NOT_AT_COMMIT and VERDICT_TRUNK_MOVED refusals need the item submitted at once, which the submit command does itself only with submit.composeOnRunner off since it became the default (#11423).
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let current = {};
  try { current = JSON.parse(readFileSync(settings, 'utf8')); } catch { /* no machine settings yet */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(settings, JSON.stringify({ ...current, submit: { ...current.submit, composeOnRunner: false } }));
  const reviewer = join(box.dir, 'moving-reviewer');
  const moveHead = join(box.dir, 'move-review-head');
  const moveMain = join(box.dir, 'move-review-main');
  assert.equal((await helpers.commitFile(box, box.repo, 'web/stamp.txt', 'stamp\n', 'chore: the stamp the check reads [G1]')).status, 0);
  const baseline = box.git(box.repo, 'rev-parse', 'main');
  const check = `test -f web/stamp.txt && grep -q '^feature = 1$' web/feature.js && if test -f '${moveHead}'; then git -C '${reviewer}' checkout -q --detach '${baseline}'; fi && if test -f '${moveMain}'; then mkdir -p '${box.repo}/web' && printf 'feature = 1\\n' > '${box.repo}/web/feature.js' && git -C '${box.repo}' add web/feature.js && git -C '${box.repo}' commit -q -m 'chore: move review trunk [G1]'; fi`;
  run(box, box.repo, 'add', 'web', 'Moving review', '--specs', 'G1', '--check', check, '--brief', 'Files: web/feature.js\nTest: the frozen check', '--criterion', 'The feature matches the caller.', '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal((await helpers.commitFile(box, box.web, 'web/feature.js', 'feature = 1\n', 'feat(web): moving review feature [G1]')).status, 0);
  await go(box, box.web, 'submit', '1');
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  // Main moving after the submit makes its proof unreusable, so the review runs the frozen check itself.
  // The move changes a file the check names: a move that misses the check's files leaves the submit proof reusable.
  assert.equal((await helpers.commitFile(box, box.repo, 'web/stamp.txt', 'moved\n', 'chore: main moves after the submit [G1]')).status, 0);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  writeFileSync(moveHead, 'armed');
  const moved = await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the live reviewer checkout.', '--json');
  assert.equal(moved.code, 1, moved.out + moved.err);
  assert.equal(JSON.parse(moved.out).error.code, 'NOT_AT_COMMIT');
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), baseline, 'the actual checkout moved while its private check was running: ' + moved.out + moved.err);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveHead);
  box.git(reviewer, 'checkout', '-q', '--detach', submitted);
  const preMove = box.git(box.repo, 'rev-parse', 'main');
  writeFileSync(moveMain, 'armed');
  const mainMoved = await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'The check moved the known main.', '--json');
  assert.equal(mainMoved.code, 1, mainMoved.out + mainMoved.err);
  assert.equal(JSON.parse(mainMoved.out).error.code, 'VERDICT_TRUNK_MOVED');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), baseline);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), []);
  rmSync(moveMain);
  // The moved trunk added the item's file itself: it merges, but the reviewed patch no longer composes unchanged,
  // so verify refuses VERDICT_TRUNK_MOVED. Put main back to run the review again.
  box.git(box.repo, 'reset', '-q', '--hard', preMove);
  await go(box, reviewer, 'verify', '1', 'accept', '--note', 'The candidate and known trunk stayed fixed through the complete frozen check.');
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, 1);
});
