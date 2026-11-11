/** Explain owner-sensitive outside changes from trusted main policy and exact Git objects, never execution. */
import { git } from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";

/** Fixed trust boundaries cannot be removed by a project's extensions or the contributed configuration. */
export const OUTSIDE_SENSITIVE_PATHS = Object.freeze([
  '.githooks/', '.husky/', '.github/workflows/', 'packages/kernel/src/logic/seal.js', 'packages/link/src/io/relay/requests.js',
  'packages/link/src/io/relay/execution.js', 'src/relay-sender.js', 'packages/state/src/logic/relay/sender.js',
  'src/board-engine-ports.js', 'packages/store/src/io/board/ports.js',
  'packages/commits/src/io/hooks.js', 'apps/cli/src/io/commands/hook.js', 'apps/cli/src/io/commands/hooks.js', 'pullboard.json', 'apps/relay/',
  'apps/cli/pullboard.js', 'apps/cli/src/io/current.js', 'apps/cli/src/io/gate/drive.js', 'apps/cli/src/io/hook/composed.js',
  'apps/cli/src/io/landing/', 'apps/cli/src/io/ports/process.js', 'apps/cli/src/io/resident/', 'apps/cli/src/io/static/',
  'apps/lib/src/io/check/baseline.js', 'apps/lib/src/io/drive/worker.js', 'apps/lib/src/io/handoff/dispatcher.js',
  'apps/lib/src/io/landing/candidate.js', 'apps/runner/src/io/controller.js', 'apps/runner/src/io/shell.js', 'docs/tools/', 'packages/gate/bin/',
  'packages/codemap/data/baselines/lints/', 'packages/codemap/data/plan/', 'packages/codemap/src/io/shims.js',
  'packages/codemap/src/io/cell/scripts/lints.js', 'packages/codemap/src/io/cells/backlog.js', 'packages/codemap/src/io/cells/move.js',
  'packages/codemap/src/io/cells/snapshots.js', 'packages/codemap/src/io/cells/door.js', 'packages/codemap/src/io/cells/shims.js',
  'packages/codemap/src/io/cells/git.js', 'packages/codemap/src/io/cells/placement.js', 'packages/codemap/src/io/cells/move/tool.js',
  'packages/codemap/src/io/cells/plan/cuts.js', 'packages/codemap/src/io/cells/scripts/cache.js', 'packages/codemap/src/io/cells/scripts/plan.js',
  'packages/resources/src/io/handoff/worker/detach.js', 'packages/pages/src/logic/sealed.js', 'packages/spec/src/io/signature.js',
  'packages/keys/src/io/relay.js', 'packages/keys/src/logic/device.js', 'packages/person/src/io/main.js', 'packages/person/src/logic/request.js',
  'packages/spec/src/io/row/decisions.js', 'packages/spec/src/io/row/stale.js', 'packages/spec/src/io/approval.js',
  'packages/store/src/io/baseline/spec/approval.js',
]);

/** Cells that hold gate, landing, merge, verdict or credential code; the committed plan names them, so a move follows. */
export const SENSITIVE_CELLS = Object.freeze(['gate', 'landing', 'merge', 'verify', 'keys', 'person']);

/** Every path a sensitive cell owns: its package root, its pre-move directory and each file the plan moves for it. */
export function planSensitivePaths(plan) {
  const found = new Set();
  for (const name of SENSITIVE_CELLS) {
    const cell = plan.cells.find(row => row.name === name);
    if (!cell) throw new Refused('SENSITIVE_CELL_MISSING', `the trusted cells plan has no ${name} cell; the outside sensitive list cannot be derived without it`);
    if (cell.root) found.add(`${cell.root}/`);
    found.add(`src/${cell.name}/`);
    for (const [from, to] of cell.paths) found.add(from).add(to);
  }
  return [...found].sort();
}

/** The fixed trust boundaries plus the plan-derived sensitive cell paths, as the classifier reads them. */
export function outsideSensitivePaths(plan) {
  return Object.freeze([...OUTSIDE_SENSITIVE_PATHS, ...planSensitivePaths(plan)]);
}

/** Read the cells plan at a trusted commit, the same index and shards packages/codemap/src/io/cells/scripts/plan.js reads. A project with no plan
 * returns null and keeps the fixed list; a plan that exists but cannot be read fails closed, never as a shorter list. */
function planAt(root, commit) {
  let index;
  try { index = git(root, ['show', `${commit}:packages/codemap/data/plan/cells.json`], { maxBuffer: 1024 * 1024 }); } catch { return null; }
  try {
    const head = JSON.parse(index);
    const cells = head.cells.map(row => JSON.parse(git(root, ['show', `${commit}:${row.file}`], { maxBuffer: 1024 * 1024 })));
    return { ...head, cells };
  } catch (error) {
    throw new Refused('NO_CELLS_PLAN', `the trusted main at ${commit} has a cells plan that cannot be read; outside intake refuses to classify without the sensitive set (${error.message})`);
  }
}

/** Read a committed text blob; unreadable, binary and invalid UTF-8 input fails closed as sensitive. */
function textAt(root, commit, path) {
  const text = git(root, ['show', `${commit}:${path}`], { maxBuffer: 1024 * 1024 });
  if (text.includes('\0') || text.includes('�')) throw new Error('not readable text');
  return text;
}

/** Match only declared relative exact paths or trailing-slash prefixes, like lane ownership paths. */
function declared(path, pattern) {
  return path === pattern || pattern.endsWith('/') && path.startsWith(pattern);
}

/** Record a reason for every rule/path match; a display can explain the hold without rerunning the classifier. */
export function outsideSensitivity(root, base, commit, paths, { mainPolicy }) {
  const trusted = mainPolicy(root);
  const configured = trusted.config.intake?.sensitivePaths ?? [];
  if (!Array.isArray(configured) || configured.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..') || /[\r\n\0]/u.test(path))) {
    throw new Refused('BAD_CONFIG', 'intake.sensitivePaths in trusted main is a list of relative exact files or trailing-slash prefixes; correct it before intake');
  }
  const fixed = outsidePlanPaths(root, trusted.commit);
  const reasons = [];
  for (const path of paths) {
    for (const pattern of fixed) if (declared(path, pattern)) reasons.push({ path, rule: 'declared-sensitive-path', detail: pattern });
    for (const pattern of configured) if (declared(path, pattern)) reasons.push({ path, rule: 'configured-sensitive-path', detail: pattern });
    if (/(^|\/)(?:\.?(?:huskyrc|lintstagedrc)(?:\..*)?|\.?lefthook(?:\..*)?|\.pre-commit-config\.(?:yaml|yml))$/iu.test(path)) reasons.push({ path, rule: 'hook-configuration', detail: 'hook tool configuration' });
    try {
      const content = textAt(root, commit, path);
      if (path === 'package.json') {
        const next = JSON.parse(content);
        let previous = {};
        try { previous = JSON.parse(textAt(root, base, path)); } catch { /* A new package has no earlier fields. */ }
        for (const field of ['scripts', 'engines', 'husky', 'lint-staged', 'simple-git-hooks']) {
          if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) reasons.push({ path, rule: 'package-execution-policy', detail: field });
        }
      }
      const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, commit, '--', path], { maxBuffer: 2 * 1024 * 1024 });
      const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
      if (/child_process|\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|runProfiledShell(?:Async)?|runShell|runCommand|shell|runner)\s*\(/u.test(added)) {
        reasons.push({ path, rule: 'new-process-execution', detail: 'added child_process import, process-execution call or shell-runner call' });
      }
    } catch {
      reasons.push({ path, rule: 'unreadable-changed-file', detail: 'the classifier could not read and classify the exact committed file' });
    }
  }
  return reasons;
}

/** Fixed boundaries plus the plan-derived cell paths, read from the trusted main commit. */
function outsidePlanPaths(root, commit) {
  const plan = planAt(root, commit);
  return plan ? outsideSensitivePaths(plan) : OUTSIDE_SENSITIVE_PATHS;
}
