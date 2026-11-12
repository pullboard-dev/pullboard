/** The shared Roadmap board for the stage-word journeys: seven items in each state across two repos and three releases [N26,N38]. */
import assert from 'node:assert/strict';
import {
  machine,
  project,
  build,
  sendBack,
  accept,
} from './harness.js';

/**
 * Build the demo and beacon projects with one item in each stage and three milestones.
 *
 * Why: two journeys read the same board, so its setup lives here instead of costing both the same CLI launches.
 *
 * @param {(name: string) => void} phase - Records which fixture phase ran, for a timeout diagnostic.
 * @returns {{ box: object, alpha: object, beacon: object, titles: string[] }} The machine, both projects and the item titles.
 */
export function roadmapStagesBoard(phase) {
  const machineBox = machine();
  // The commit and merge hooks are several Node launches each; this board tests the Roadmap page, not the hooks, so its Git work skips them.
  const unhooked = (cwd, ...args) => machineBox.git(cwd, ...(['commit', 'merge'].includes(args[0]) ? ['-c', 'core.hooksPath=/dev/null'] : []), ...args);
  const box = { ...machineBox, git: unhooked };
  const alpha = project(box, 'roadmap-demo');
  const beacon = project(box, 'beacon');
  phase('projects-ready');
  const long = 'A deliberately long title that runs past the width of a phone and keeps going, far enough to be cut on a wide desktop card as well';
  const titles = ['Merged greeting page', 'Verified farewell page', 'Session timeout banner', 'Upload progress bar', 'Live search results', long, 'Withdrawn experiment'];
  for (const title of titles) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // One item in each state: verified and merged, verified, sent back, to verify, building, open, withdrawn.
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  const itemCommit = box.git(alpha.repo, 'rev-parse', alpha.branch);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, itemCommit, 'the Roadmap receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  build(box, alpha, 2, 'two.txt');
  accept(box, alpha, 2);
  build(box, alpha, 3, 'three.txt');
  sendBack(box, alpha, 3, 'the banner does not time out yet');
  build(box, alpha, 4, 'four.txt');
  box.run(alpha.web, 'claim', '5');
  box.run(alpha.repo, 'withdraw', '7', 'no longer needed');
  // Another repo's item, sent back on its own board.
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  build(box, beacon, 1, 'retry.txt');
  sendBack(box, beacon, 1, 'retry twice before failing');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships when the review lands; your call on the name.', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--note', 'Queued behind Launch.', '--reason', 'Arrange fixture release', '--items', '5,6,7');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Ideas not filed yet.');
  return { box, alpha, beacon, titles };
}
