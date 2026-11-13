/** The shared Roadmap board for the stage-word journeys: seven items in each state across two repos and three releases [N26,N38]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machine } from './harness.js';
import { project } from './harness.js';

/**
 * Build the demo and beacon projects with one item in each stage and three milestones.
 *
 * Why: two journeys read the same board, so its setup lives here instead of costing both the same CLI launches.
 *
 * @param {(name: string) => void} phase - Records which fixture phase ran, for a timeout diagnostic.
 * @returns {Promise<{ box: object, alpha: object, beacon: object, titles: string[] }>} The machine, both projects and the item titles.
 */
export async function roadmapStagesBoard(phase) {
  const machineBox = machine();
  // The commit and merge hooks are several Node launches each; this board tests the Roadmap page, not the hooks, so its Git work skips them.
  const unhooked = (cwd, ...args) => machineBox.git(cwd, ...(['commit', 'merge'].includes(args[0]) ? ['-c', 'core.hooksPath=/dev/null'] : []), ...args);
  const box = { ...machineBox, git: unhooked };
  /** The harness's build, run in this process so each CLI call costs no node launch [C7]. */
  const build = async (p, id, file) => {
    const key = `${p.baseBranch}:${id}`;
    let branch = p.itemBranches.get(key);
    if (!branch) { branch = `${p.baseBranch}-item-${id}`; box.git(p.web, 'switch', '-q', '-c', branch, p.baseBranch); p.itemBranches.set(key, branch); }
    else box.git(p.web, 'switch', '-q', branch);
    p.branch = branch;
    await box.inProcess(p.web, 'claim', String(id));
    mkdirSync(join(p.web, 'web'), { recursive: true });
    writeFileSync(join(p.web, 'web', file), `${file}\n`);
    box.git(p.web, 'add', '-A');
    box.git(p.web, 'commit', '-q', '-m', `feat(web): ${file} [G1]`);
    await box.inProcess(p.web, 'submit', String(id), '--no-next');
  };
  /** The harness's accept, in process. */
  const accept = async (p, id) => {
    box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
    await box.inProcess(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
    box.git(p.repo, 'switch', '-q', 'main');
  };
  /** The harness's sendBack, in process. */
  const sendBack = async (p, id, note) => {
    box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
    const item = JSON.parse(await box.inProcess(p.repo, 'show', String(id), '--json'));
    await box.inProcess(p.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', JSON.parse(item.item_frozen).criterion, '--note', note, '--as', 'coordinator');
    box.git(p.repo, 'switch', '-q', 'main');
  };
  const alpha = project(box, 'roadmap-demo');
  const beacon = project(box, 'beacon');
  phase('projects-ready');
  const long = 'A deliberately long title that runs past the width of a phone and keeps going, far enough to be cut on a wide desktop card as well';
  const titles = ['Merged greeting page', 'Verified farewell page', 'Session timeout banner', 'Upload progress bar', 'Live search results', long, 'Withdrawn experiment'];
  for (const title of titles) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // One item in each state: verified and merged, verified, sent back, to verify, building, open, withdrawn.
  await build(alpha, 1, 'one.txt');
  await accept(alpha, 1);
  const itemCommit = box.git(alpha.repo, 'rev-parse', alpha.branch);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, itemCommit, 'the Roadmap receipt names the trunk merge commit');
  await box.inProcess(alpha.repo, 'merged', '1', trunkCommit);
  await build(alpha, 2, 'two.txt');
  await accept(alpha, 2);
  await build(alpha, 3, 'three.txt');
  await sendBack(alpha, 3, 'the banner does not time out yet');
  await build(alpha, 4, 'four.txt');
  await box.inProcess(alpha.web, 'claim', '5');
  await box.inProcess(alpha.repo, 'withdraw', '7', 'no longer needed');
  // Another repo's item, sent back on its own board.
  await box.inProcess(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  await build(beacon, 1, 'retry.txt');
  await sendBack(beacon, 1, 'retry twice before failing');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships when the review lands; your call on the name.', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,beacon#1');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--note', 'Queued behind Launch.', '--reason', 'Arrange fixture release', '--items', '5,6,7');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Ideas not filed yet.');
  return { box, alpha, beacon, titles };
}
