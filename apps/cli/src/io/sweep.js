/** Helpers for `pullboard sweep`: file one routed item per flagged file. Split from src/cli.js, which re-exports it [C7]. */
import { spawnSync } from 'node:child_process';
import * as store from '../../../../packages/store/index.js';
import { idArg } from './context.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { invalidateGitFacts } from '../../../../packages/git/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { briefFiles } from '../../../../packages/items/index.js';
import { parseProblems } from './sweep/problems.js';
import { sweepItems } from './sweep/problems.js';
import { ordered } from './claim.js';

/** Describe only repairs whose checker rule supplies a concrete, scope-preserving change. */
function diagnosisFor(item, problems) {
  const found = problems.filter((problem) => problem.file === item.file);
  if (!found.length || found.some((problem) => problem.rule !== 'no-var')) return null;
  const lines = found.map((problem) => `- line ${problem.line}${problem.col ? `:${problem.col}` : ''} ${problem.rule}: ${problem.message}`);
  return [
    `Files: ${item.file}`,
    'Change:',
    'Replace each flagged var with let or const as appropriate, preserving scope and behavior:',
    ...lines,
    'Out of scope: other files, suppressions, disabled rules, or behavior changes.',
    'Test case:',
    `The unchanged check (${item.check}) reports no problems for ${item.file}, and existing tests pass.`,
  ].join('\n');
}

/**
 * `pullboard sweep` (N15, N17): run a checker, then file one routed item per file it flags, each
 * with the problems in its brief and the checker on that file as its check. Each check runs once
 * first, on the file as it is: it must fail there, or it could never prove a fix.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {any} values
 * @returns {Promise<number>}
 */
export async function sweepHere(ctx, board, me, values) {
  if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'the coordinator files sweep items, from the main checkout');
  const report = String(values.run ?? '').trim();
  const check = String(values.check ?? '').trim();
  if (!report || !check.includes('{file}')) {
    throw new Refused('USAGE', 'pullboard sweep --run "<checker over the repo>" --check "<the checker on one file, with {file} where its path goes>"');
  }
  const max = values.max === undefined ? 20 : idArg(values.max, 'a number after --max');
  const ran = spawnSync(report, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  invalidateGitFacts();
  const problems = parseProblems(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`, ctx.info.root);
  if (!problems.length) {
    ctx.io.say(`the checker reported no problems I can read (exit ${ran.status}); nothing to file`);
    return 0;
  }
  const covered = new Set(store.listItems(board).filter((item) => item.item_title.startsWith('fix ')).flatMap((item) => briefFiles(item.item_brief)));
  const { items, skipped } = sweepItems(problems, {
    laneOf: (path) => laneOf(ctx.config, path),
    covered,
    check,
    report,
    route: values.route ?? 'light',
    max,
  });
  const blind = [];
  for (const item of items) {
    const canary = spawnSync(item.check, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    invalidateGitFacts();
    if (canary.status === 0) {
      blind.push(item.file);
      continue;
    }
    const diagnosis = item.route === 'light' ? diagnosisFor(item, problems) : null;
    const route = item.route === 'light' && !diagnosis ? 'mid' : item.route;
    if (values['dry-run']) {
      ctx.io.say(`would file: ${item.title} (${item.lane} lane, ${route})`);
      continue;
    }
    const initialRoute = route === 'light' ? 'mid' : route;
    const id = await ordered(ctx, board, 'addItem', [{ by: me.id, lane: item.lane, title: item.title, criterion: item.criterion, brief: item.brief, route: initialRoute, check: item.check }]);
    if (diagnosis) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'diagnosis', text: diagnosis }]);
    ctx.io.say(`#${id} ${item.title} (${item.lane} lane, ${route})`);
  }
  if (skipped.length) ctx.io.say(`already open: ${skipped.join(', ')}`);
  if (blind.length) {
    const refusal = new Refused('CHECK_CANNOT_FAIL', `the check passes on ${blind.join(', ')} although the checker flags problems there, so it could never prove a fix; not filed. A check ending in a pipe takes its exit status from the last command. Fix the check so flagged files make it fail, then run pullboard sweep again.`);
    ctx.io.refusal?.(refusal);
    ctx.io.err(`pullboard: ${refusal.message}`);
  }
  const filed = items.length - blind.length;
  ctx.io.say(`${problems.length} problems in ${new Set(problems.map((problem) => problem.file)).size} files; ${values['dry-run'] ? 'would file' : 'filed'} ${filed}`);
  return blind.length ? 1 : 0;
}

