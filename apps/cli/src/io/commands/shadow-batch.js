import { git } from '../../../../../packages/git/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
/** Dry-run the landing gate over a batch of accepted items, changing neither the board nor main [V4,C7]. */
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { scratchFolder } from '../../../../../packages/config/index.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
const fs = fileSystemAdapter();

const USAGE = 'use pullboard shadow-batch <id> <id>... [--json] to run the tier-2 checks once over accepted items composed onto main';

/** The numeric item ids named on the command line, each once and in order. */
function idsOf(first, second, rest) {
  const ids = [first, second, ...rest].filter(value => value !== undefined);
  if (!ids.length || ids.some(value => !/^[1-9][0-9]*$/u.test(String(value)))) throw new Refused('USAGE', USAGE);
  const numbers = ids.map(Number);
  if (new Set(numbers).size !== numbers.length) throw new Refused('USAGE', 'name each item once; ' + USAGE);
  return numbers;
}

/** Read the named items and require each to be accepted (verified) and not yet landed, with a real commit. */
function acceptedItems(board, ids) {
  const items = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  return ids.map(id => {
    const item = items.get(id);
    if (!item) throw new Refused('NO_SUCH_ITEM', `#${id} is not on this board; run pullboard list to see the items`);
    if (item.item_status !== 'verified' || item.item_merged_commit || !item.item_commit) {
      throw new Refused('NOT_ACCEPTED', `#${id} is ${item.item_merged_commit ? 'already landed' : item.item_status}, and shadow-batch composes only accepted items; wait for its accept, then retry`);
    }
    return { id, commit: item.item_commit };
  });
}

/** The tier-2 checks this project declares: static checks first, then the full gate that landing runs. */
function tierTwoChecks(config) {
  return [['static', config.staticChecks], ['gate', config.gate]].filter(([, command]) => typeof command === 'string' && command.trim());
}

/** Run one shell check in the scratch tree and measure it. */
function runCheck(name, command, cwd) {
  const started = performance.now();
  const child = spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: environmentAdapter().all() });
  return { name, command, green: child.status === 0, exitCode: child.status, ms: Math.round(performance.now() - started),
    tail: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n') };
}

/** Compose the accepted commits onto main in a scratch worktree, run each tier-2 check once, and remove the worktree. */
export function run(io, { first, second, rest, values }) {
  if (Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', USAGE);
  const ids = idsOf(first, second, rest);
  const ctx = context(io);
  const items = withBoardRead(ctx, board => acceptedItems(board, ids));
  const root = ctx.info.root;
  const main = git(root, ['rev-parse', 'refs/heads/main']).trim();
  const scratch = scratchFolder('pullboard-shadow-batch-');
  const started = performance.now();
  let merged = [], conflict = null, results = [];
  try {
    git(root, ['worktree', 'add', '--detach', '-q', scratch, main]);
    const env = { ...environmentAdapter().all(), GIT_AUTHOR_NAME: 'pullboard shadow-batch', GIT_AUTHOR_EMAIL: 'shadow-batch@pullboard.invalid', GIT_COMMITTER_NAME: 'pullboard shadow-batch', GIT_COMMITTER_EMAIL: 'shadow-batch@pullboard.invalid' };
    for (const item of items) {
      const attempt = tryGit(scratch, ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', '-q', item.commit], { env });
      if (attempt.status !== 0) { tryGit(scratch, ['merge', '--abort']); conflict = item.id; break; }
      merged.push(item.id);
    }
    if (conflict === null) results = tierTwoChecks(ctx.config).map(([name, command]) => runCheck(name, command, scratch));
  } finally {
    tryGit(root, ['worktree', 'remove', '--force', scratch]);
    fs.rm(scratch, { recursive: true, force: true });
    tryGit(root, ['worktree', 'prune']);
  }
  const wallMs = Math.round(performance.now() - started);
  const green = conflict === null && results.every(result => result.green);
  io.result?.({ shadowBatch: { items: ids, main, composed: merged, conflict, wallMs, checks: results.map(({ tail, command, ...row }) => row), green } });
  io.say(`shadow-batch of ${ids.map(id => `#${id}`).join(', ')} onto main ${main.slice(0, 12)}: board and main unchanged`);
  if (conflict !== null) {
    io.say(`#${conflict} does not merge cleanly after ${merged.length ? merged.map(id => `#${id}`).join(', ') : 'main'}; no check ran`);
    io.say(`wall time ${wallMs} ms`);
    return 1;
  }
  if (!results.length) io.say('this project declares no tier-2 checks (staticChecks or gate); nothing ran');
  for (const result of results) {
    io.say(`${result.name}: ${result.green ? 'green' : `red (exit ${result.exitCode})`} in ${result.ms} ms`);
    if (!result.green && result.tail) io.say(result.tail);
  }
  io.say(`wall time ${wallMs} ms`);
  return green ? 0 : 1;
}
