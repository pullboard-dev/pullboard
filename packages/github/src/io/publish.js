/**
 * Tier 2 of landing (#801): publish runs the whole suite on the exact local trunk head and pushes that head to the
 * remote only when every test passes. A red head is never pushed: the report names every failing test from the one
 * run and, for each failing file, the items landed since the last published head whose merges touched it. The same
 * red head is not run again; publish waits for a new head.
 */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from '../../../landing/index.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { runGate } from '../../../gate/index.js';
import { git } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { landingFailures } from '../../../landing/index.js';
import { landingRemote } from '../../../landing/index.js';
import { Refused } from '../../../kernel/index.js';
import { publishPullRequests } from './pr/publish.js';
import { publishStateFile } from '../../../landing/index.js';

/** Where publish remembers the last head it found red, so the same head is not run again. */
function stateFile(root) {
  return publishStateFile(root);
}

/** The head publish last found red, or null. */
function lastRed(root) {
  try { return JSON.parse(readFileSync(stateFile(root), 'utf8')).red ?? null; } catch { return null; }
}

/** The commit the remote branch names now, or null when it names none. */
function remoteHead(root, remote, branch) {
  const listed = tryGit(root, ['ls-remote', remote, `refs/heads/${branch}`]);
  return listed.status === 0 ? listed.stdout.split(/\s+/u)[0] || null : null;
}

/**
 * For each failing file, the items landed between the published head and this head whose merge touched it: each
 * first-parent merge on the trunk is matched to the item whose merged commit it is, and to the files it changed.
 */
function touchedBy(root, board, published, head, files) {
  const range = published ? `${published}..${head}` : head;
  const merges = tryGit(root, ['rev-list', '--first-parent', range]).stdout.split('\n').filter(Boolean);
  const items = store.listItems(board, { all: true }).filter(item => item.item_merged_commit);
  const byMerge = new Map(items.map(item => [item.item_merged_commit, item.item_id]));
  const touched = new Map(files.map(file => [file, []]));
  for (const merge of merges) {
    const id = byMerge.get(merge);
    if (!id) continue;
    const changed = tryGit(root, ['diff', '--name-only', `${merge}^1`, merge]).stdout.split('\n').filter(Boolean);
    for (const file of files) if (changed.includes(file) && !touched.get(file).includes(id)) touched.get(file).push(id);
  }
  return touched;
}

/**
 * Publish the local trunk head (#801): run the whole suite on exactly that head in a private worktree; push it when
 * green; otherwise report every failing test with the landed items that touched its file, and remember the head so
 * the next publish waits for a new one.
 *
 * @param {{ root: string, board: any, config: any, say: (line: string) => void, onWait?: Function, onFailure?: Function }} options
 * @returns {Promise<{ head: string, published: boolean, red: Array<{ file: string|null, name: string, items: number[] }>, waiting?: boolean }>}
 */
export async function publishTrunk({ root, board, config, say, onWait, onFailure, write }) {
  const trunk = mainCheckout(root);
  if (!trunk?.commit) throw new Refused('LAND_TRUNK', 'publish needs the coordinator’s primary branch; return its checkout to the trunk');
  const branch = trunk.branch.replace(/^refs\/heads\//u, '');
  const remote = landingRemote(root, trunk.branch);
  if (!remote) throw new Refused('LAND_PUSH', `the landing push failed: this repo has no remote to push ${branch} to; add one with git remote add origin <url> and run pullboard publish again`);
  const head = trunk.commit;
  const published = remoteHead(root, remote, branch);
  if (config.publish?.pullRequest) return await publishPullRequests({ root, board, config, say, onWait, onFailure, write,
    branch, remote, head, published });
  if (published === head) {
    say(`${branch} at ${head.slice(0, 12)} is already published`);
    return { head, published: true, red: [] };
  }
  if (lastRed(root) === head) {
    say(`${branch} at ${head.slice(0, 12)} was red; publish waits for a new head: land a fix, then run pullboard publish again`);
    return { head, published: false, red: [], waiting: true };
  }
  const directory = join(repoInfo(root).commonDir, 'pullboard', 'publish', randomUUID());
  mkdirSync(join(directory, '..'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', directory, head]);
  let gate;
  try {
    gate = await runGate(directory, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true, agent: 'coordinator', onWait, onFailure });
    // Push from the worktree that ran the suite, so the pre-push hook reads that run's green stamp instead of rerunning it.
    if (gate.isGreen) {
      // Landing depends on the full-suite verdict, independently of whether the subsequent network push succeeds.
      writeFileSync(stateFile(root), JSON.stringify({ green: head, published, receipt: gate.receiptId ?? null }) + '\n');
      const pushed = tryGit(directory, ['push', remote, `HEAD:refs/heads/${branch}`]);
      if (pushed.status !== 0) throw new Refused('LAND_PUSH', `the landing push failed: ${pushed.stderr || pushed.stdout}; inspect the remote and hooks, then run pullboard publish again`);
    }
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', directory]);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
  if (gate.isGreen) {
    writeFileSync(stateFile(root), JSON.stringify({ published: head, receipt: gate.receiptId ?? null }) + '\n');
    say(`published ${branch} at ${head.slice(0, 12)}: the whole suite passed`);
    return { head, published: true, red: [] };
  }
  const failures = landingFailures(gate.output ?? '', directory);
  const files = [...new Set(failures.map(failure => failure.file).filter(Boolean))];
  const touched = touchedBy(root, board, published, head, files);
  const red = failures.map(failure => ({ file: failure.file, name: failure.name, items: failure.file ? touched.get(failure.file) : [] }));
  writeFileSync(stateFile(root), JSON.stringify({ red: head, published, receipt: gate.receiptId ?? null, failures: red }) + '\n');
  say(`${branch} at ${head.slice(0, 12)} is red and was not pushed; ${red.length} failing ${red.length === 1 ? 'test' : 'tests'}:`);
  for (const entry of red) {
    say(`  ${entry.file ?? '(no file)'}: ${entry.name}; ${entry.items.length ? 'touched by ' + entry.items.map(id => `#${id}`).join(', ') : 'touched by no item landed since the last published head'}`);
  }
  return { head, published: false, red };
}
