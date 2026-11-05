/**
 * The person's code and test quality rules as checks Rigor runs by itself [D1,D3]. Each rule reads
 * one change, from the merge base with main to HEAD, and names every breach as
 * `path:line: <rule> <what broke>`, the same shape bin/checks prints, so a doctrine row's
 * `gate: check` can count it. Why a change and not the whole tree: these rules judge how a change
 * was made (a fix and its test, a new guard and the test that catches its loss), which only a
 * diff can show, and an old file never breaks a rule its author never saw.
 *
 * Nothing here drafts or approves a row; rigor-quality-draft.js drafts them for the person.
 */
import { spawnSync } from './windows-child-process.js';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  lex,
  lineAt,
} from './js-lex.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from './git.js';
import { Refused } from './refused.js';

/** The line cap a changed file is held to, as Doctrine C9 holds it. */
export const LINE_CAP = 1500;

/** How many lines of non-test code one change may add, net, before Rigor names it. */
export const GROWTH_BUDGET = 400;

/** How long one test run inside a mutation or control may take. */
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The rules, in the order Rigor reports and drafts them. `text` is the rule; `how` says plainly
 * what the check reads and what it leaves to review, so the person approves exactly what runs.
 * Neither may hold a field separator, since each becomes one doctrine row.
 */
export const QUALITY_RULES = Object.freeze([
  { key: 'fix-test', section: 'T', text: 'A fix ships with a test that reproduces the original failure.',
    how: 'Rigor names each fix commit that changes no test file, at the first line it changes; whether the test reproduces the failure is the root-cause-control rule.' },
  { key: 'fails-closed', section: 'T', text: 'A new gate or check has a test that fails closed when it has no data.',
    how: 'Rigor names a new file under checks/ or gates/, or named *-check or *-gate, that no test changed in the same change names; whether that test feeds it no data and expects a refusal is review, since no command can read what a test asserts.' },
  { key: 'silent-catch', section: 'C', text: 'No silent catch or fallback: each one logs a specific line that names its subject.',
    how: 'Rigor names each catch clause and .catch handler a change adds to a source file that neither throws nor writes a line; a fallback written with a default operator is review.' },
  { key: 'guard-mutation', section: 'T', text: 'A guard test fails when the guard is deleted.',
    how: 'Rigor turns each throw a change adds to a source file into a no-op, one at a time, and runs the test files the change touches; a guard they still pass without is named.' },
  { key: 'size-budget', section: 'C', text: `A file over the ${LINE_CAP}-line cap, or a change that grows code past its ${GROWTH_BUDGET}-line budget, is named.`,
    how: `Rigor names each changed source file that ends over ${LINE_CAP} lines and grew, and a change whose non-test code grows by more than ${GROWTH_BUDGET} lines net, or the board's rigor.budget setting, at the file that grew most.` },
  { key: 'root-cause-control', section: 'T', text: 'A root cause is proven by a control that would have come out differently before the fix lands.',
    how: 'Rigor runs each fix commit\'s changed test files on the fix\'s parent, where they must fail, and at the fix, where they must pass; a cause argued only in prose is review.' },
]);

/** A test file in any common layout: a test folder, or a name that says test or spec. */
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/u;

/** A JavaScript source file, the only kind the catch and guard rules can lex. */
const SCRIPT = /\.[cm]?js$/u;

/** A file the size rule counts, as bin/checks/file-size.js does. */
const SIZED = /\.(?:[cm]?js|css)$/u;

/** A new gate or check, by folder or by name. */
const CHECK_FILE = /(?:^|\/)(?:checks|gates)\/[^/]+\.[cm]?js$|[-_.](?:check|gate)s?\.[cm]?js$/u;

/** A fix commit, by its conventional header type. */
const FIX = /^fix(?:\([^)]*\))?!?:/u;

/** A call that writes a line somewhere a person or a log reads it. */
const LOGS = /\b(?:console\s*\.\s*(?:log|warn|error|info|debug)|std(?:err|out)\s*\.\s*write|(?:io|logger|log)\s*\.\s*\w+|say|warn\w*|log\w*|report\w*|reject)\s*\(/u;

/** Run git without the caller's repository selectors; null when git refuses. */
function gitOut(cwd, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args],
    { cwd, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** One commit id for a revision, or null when it names none. */
function commitOf(root, revision) {
  return gitOut(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])?.trim() || null;
}

/**
 * The change Rigor reads: from the merge base of `base` and `head` to `head`. Without `base`, the
 * first of the main checkout's branch, main, origin/main and master that `head` has grown past;
 * with none of them, the range is empty, so a repository with no main has nothing to judge
 * rather than everything.
 *
 * @param {string} root
 * @param {{ base?: string, head?: string }} [range]
 * @returns {{ base: string, head: string }}
 */
export function changeRange(root, { base, head = 'HEAD' } = {}) {
  const tip = commitOf(root, head);
  if (!tip) throw new Refused('RIGOR_RANGE', `${head} names no commit; pass --head a commit or branch, or commit first`);
  if (base !== undefined) {
    const given = commitOf(root, base);
    const merged = given && gitOut(root, ['merge-base', given, tip])?.trim();
    if (!merged) throw new Refused('RIGOR_RANGE', `${base} shares no history with ${head}; pass --base a commit or branch that ${head} grew from`);
    return { base: merged, head: tip };
  }
  const branch = mainCheckout(root)?.branch;
  for (const candidate of [branch, 'main', 'origin/main', 'master'].filter(Boolean)) {
    const found = commitOf(root, candidate);
    const merged = found && gitOut(root, ['merge-base', found, tip])?.trim();
    // A candidate that already holds HEAD (the branch HEAD is on, in a one-checkout repo) says nothing.
    if (merged && merged !== tip) return { base: merged, head: tip };
  }
  return { base: tip, head: tip };
}

/**
 * Parse a zero-context diff into each file's status and added lines, numbered at the new side.
 * Why not `+++` alone: with -U0 a removed line `-- x` prints as `--- x`, so headers are read
 * only between `diff --git` and the first hunk.
 *
 * @param {string} text
 * @returns {Map<string, { status: 'A' | 'M' | 'D', added: { line: number, text: string }[], hunks: { oldStart: number, oldCount: number, newStart: number, newCount: number }[] }>}
 */
export function parseDiff(text) {
  const files = new Map();
  let current = null;
  let header = false;
  let status = 'M';
  let next = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; current = null; status = 'M'; continue; }
    if (header) {
      if (line.startsWith('new file mode')) status = 'A';
      else if (line.startsWith('deleted file mode')) status = 'D';
      else if (line.startsWith('+++ ')) {
        const name = line.slice(4);
        current = name === '/dev/null' ? null : name.replace(/^b\//u, '');
        if (current) files.set(current, { status, added: [], hunks: [] });
      } else if (line.startsWith('--- ') && status === 'D') {
        const name = line.slice(4).replace(/^a\//u, '');
        files.set(name, { status, added: [], hunks: [] });
      }
      if (!line.startsWith('@@')) continue;
      header = false;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      next = Number(hunk[3]);
      if (current) files.get(current).hunks.push({ oldStart: Number(hunk[1]), oldCount: Number(hunk[2] ?? 1), newStart: next, newCount: Number(hunk[4] ?? 1) });
      continue;
    }
    if (current && line.startsWith('+')) {
      files.get(current).added.push({ line: next, text: line.slice(1) });
      next += 1;
    }
  }
  return files;
}

/**
 * The line an unchanged new-side line had before the change, from a zero-context diff's hunks. Why not match by
 * position among same-named catches: a new catch with the same header shifts every later one (#806 third review).
 */
function lineBefore(hunks, line) {
  let shift = 0;
  for (const hunk of hunks) {
    const before = hunk.newCount === 0 ? hunk.newStart < line : hunk.newStart + hunk.newCount - 1 < line;
    if (before) shift += hunk.oldCount - hunk.newCount;
  }
  return line + shift;
}

/** The diff from one commit to another, or of one commit against its parent. */
function diffOf(root, from, to) {
  const args = from ? ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', from, to, '--']
    : ['diff-tree', '-p', '-r', '-U0', '--root', '--no-renames', '--no-color', '--no-ext-diff', to, '--'];
  return parseDiff(gitOut(root, args) ?? '');
}

/** A file's text at a commit, or null when the commit lacks it. */
function textAt(root, commit, path) {
  return gitOut(root, ['show', `${commit}:${path}`]);
}

/** Lines as an editor numbers them. */
function lineCount(text) {
  if (!text) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** The fix commits in a range, oldest first, with their subjects. */
function fixCommits(root, { base, head }) {
  if (base === head) return [];
  return (gitOut(root, ['log', '--no-merges', '--reverse', '--format=%H%x00%s', `${base}..${head}`]) ?? '')
    .split('\n').filter(Boolean).map((line) => line.split('\0')).filter(([, subject]) => FIX.test(subject))
    .map(([commit, subject]) => ({ commit, subject, parent: commitOf(root, `${commit}^`) }));
}

/** The test files a diff adds lines to and keeps. */
function changedTests(diff) {
  return [...diff].filter(([path, file]) => TEST_FILE.test(path) && file.status !== 'D' && file.added.length).map(([path]) => path);
}

/** Where a change starts: its first non-test file's first added line, else its first file. */
function firstChange(diff) {
  const entries = [...diff];
  const [path, file] = entries.find(([name, entry]) => !TEST_FILE.test(name) && entry.added.length) ?? entries[0] ?? ['(no file)', { added: [] }];
  return { path, line: file.added[0]?.line ?? 1 };
}

/** The catch clauses and .catch handlers in a source, each with its offset, closing offset and body. */
function catches(source) {
  const { code } = lex(source);
  const found = [];
  for (const match of code.matchAll(/(?<![\w$.])catch\s*(?:\([^()]*\)\s*)?\{/gu)) {
    const open = match.index + match[0].length - 1;
    const end = closing(code, open, '{', '}');
    found.push({ at: match.index, end, kind: 'clause', header: match[0], body: code.slice(open + 1, end) });
  }
  for (const match of code.matchAll(/\.\s*catch\s*\(/gu)) {
    const open = match.index + match[0].length - 1;
    const end = closing(code, open, '(', ')');
    found.push({ at: match.index + match[0].indexOf('catch'), end, kind: 'handler', header: '.catch(', body: code.slice(open + 1, end) });
  }
  return found;
}

/**
 * Each catch with its line and its place among catches of the same kind and header on that line, so a kept line
 * with two `.catch(` handlers still matches each to its own earlier self.
 */
function onLine(found, source) {
  const seen = new Map();
  return [...found].sort((a, b) => a.at - b.at).map((entry) => {
    const line = lineAt(source, entry.at);
    const key = `${line}:${entry.kind}:${entry.header.replace(/\s+/gu, ' ')}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    return { ...entry, line, slot: `${entry.kind}:${entry.header.replace(/\s+/gu, ' ')}#${seen.get(key)}` };
  });
}

/** Whether a catch body neither throws nor writes a line. */
function silent(found) {
  return !/\bthrow\b/u.test(found.body) && !LOGS.test(found.body);
}

/** A catch body with its whitespace collapsed, so a reindented old catch still matches itself. */
function bodyKey(found) {
  return found.body.replace(/\s+/gu, ' ').trim();
}

/** The offset of the bracket that closes the one at `open`, or the end of the code. */
function closing(code, open, left, right) {
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === left) depth += 1;
    else if (code[at] === right && --depth === 0) return at;
  }
  return code.length;
}

/** Every rule's breaches for one change; each check is below, one function per rule. */
const CHECKS = {
  /** A fix commit that changes no test file. */
  'fix-test': (root, range) => fixCommits(root, range).flatMap((fix) => {
    const diff = diffOf(root, fix.parent, fix.commit);
    if (changedTests(diff).length) return [];
    return [{ ...firstChange(diff), text: `fix ${fix.commit.slice(0, 12)} "${fix.subject}" changes no test that reproduces its failure` }];
  }),
  /** A new gate or check no test in the change names. */
  'fails-closed': (root, range, { diff }) => {
    const tests = changedTests(diff).map((path) => textAt(root, range.head, path) ?? '');
    return [...diff].filter(([path, file]) => file.status === 'A' && CHECK_FILE.test(path) && !TEST_FILE.test(path))
      .filter(([path]) => !tests.some((text) => text.includes(path.split('/').pop().replace(/\.[cm]?js$/u, ''))))
      .map(([path]) => ({ path, line: 1, text: 'is a new gate or check, and no test in this change runs it with no data to show it fails closed' }));
  },
  /**
   * A catch the change adds, or makes silent, that neither throws nor writes a line. A catch whose header line the
   * change keeps is matched to the catch that header had before, through the diff's line map. Why compare: rewriting
   * or only deleting an existing catch's log leaves its header untouched and may add no line at all, yet introduces
   * the silence (#806 reviews). A catch that was already silent stays old debt unless the change rewrites its body.
   */
  'silent-catch': (root, range, { diff }) => [...diff].filter(([path, file]) => SCRIPT.test(path) && !TEST_FILE.test(path) && file.status !== 'D')
    .flatMap(([path, file]) => {
      const source = textAt(root, range.head, path) ?? '';
      const baseSource = textAt(root, range.base, path) ?? '';
      const added = file.added.map((entry) => entry.line);
      const before = onLine(catches(baseSource), baseSource);
      const after = onLine(catches(source), source);
      return after.map((found) => ({ ...found, last: lineAt(source, found.end) }))
        .filter((found) => {
          if (!silent(found)) return false;
          if (added.includes(found.line)) return true;
          const was = lineBefore(file.hunks, found.line);
          const earlier = before.find((old) => old.line === was && old.slot === found.slot);
          if (!earlier) return true;
          if (!silent(earlier)) return true;
          return bodyKey(earlier) !== bodyKey(found) && added.some((line) => line > found.line && line <= found.last);
        })
        .map((found) => ({ path, line: found.line, text: `${found.kind === 'clause' ? 'catch' : '.catch handler'} is silent: it neither throws nor logs a line that names its subject` }));
    }),
  /** A throw the change adds that its tests still pass without. */
  'guard-mutation': (root, range, { diff, runTests }) => guardBreaches(root, range, diff, runTests),
  /** A grown file over the cap, and a change past its budget. */
  'size-budget': (root, range, { diff, budget }) => {
    const breaches = [];
    const growth = [];
    for (const [path, file] of diff) {
      if (!SIZED.test(path) || file.status === 'D') continue;
      const after = lineCount(textAt(root, range.head, path));
      const grew = after - lineCount(textAt(root, range.base, path));
      if (after > LINE_CAP && grew > 0) breaches.push({ path, line: LINE_CAP + 1, text: `is ${after} lines, over the ${LINE_CAP}-line cap, and this change grows it by ${grew}; split it into a new module` });
      if (!TEST_FILE.test(path)) growth.push({ path, grew, line: file.added[0]?.line ?? 1 });
    }
    const total = growth.reduce((sum, entry) => sum + entry.grew, 0);
    if (total > budget) {
      const most = growth.reduce((top, entry) => (entry.grew > top.grew ? entry : top));
      breaches.push({ path: most.path, line: most.line, text: `this change grows code by ${total} lines, past its ${budget}-line budget; split the change` });
    }
    return breaches;
  },
  /** A fix whose tests pass on its parent too, or fail at the fix. */
  'root-cause-control': (root, range, { runTests }) => fixCommits(root, range).flatMap((fix) => controlBreaches(root, fix, runTests)),
};

/**
 * Run the given test files in a checkout and say whether they passed. The child loses the parent
 * test runner's context, or a `node --test` inside a test would report into its parent.
 *
 * @param {string} cwd
 * @param {string[]} files
 * @returns {boolean}
 */
export function nodeTests(cwd, files) {
  const env = cleanGitEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd, env, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0;
}

/** A private shared clone, checked out at `commit` with hooks off; `move` checks out another. */
function scratchClone(root, commit) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-rigor-quality-'));
  const checkout = join(directory, 'checkout');
  const env = cleanGitEnvironment();
  /** Check out a commit exactly, dropping anything a run wrote. */
  const move = (target) => {
    spawnSync('git', ['clean', '-fdxq'], { cwd: checkout, env });
    const moved = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--force', '--detach', target], { cwd: checkout, env });
    if (moved.status !== 0) throw new Refused('RIGOR_RANGE', `could not check out ${target} to run its tests; fetch it, or pass --base a commit this checkout has`);
  };
  const cloned = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, stdio: 'ignore' });
  if (cloned.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Refused('RIGOR_RANGE', 'could not clone this repository to run its tests; check that git can read it, then run pullboard rigor quality again');
  }
  move(commit);
  return { checkout, move, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * The guard rule: each throw a change adds to a source file becomes `void`, one at a time, and the
 * change's tests run against that copy. Why `void`: it keeps the statement valid, so a test fails
 * only because the guard is gone, never because the file no longer parses.
 */
function guardBreaches(root, range, diff, runTests) {
  const guards = [];
  for (const [path, file] of diff) {
    if (!SCRIPT.test(path) || TEST_FILE.test(path) || !file.added.length) continue;
    const source = textAt(root, range.head, path) ?? '';
    const added = new Set(file.added.map((entry) => entry.line));
    for (const match of lex(source).code.matchAll(/\bthrow\b/gu)) {
      if (added.has(lineAt(source, match.index))) guards.push({ path, at: match.index, line: lineAt(source, match.index), source });
    }
  }
  if (!guards.length) return [];
  const tests = changedTests(diff);
  /** Name one guard with what is wrong with it. */
  const breach = (guard, text) => ({ path: guard.path, line: guard.line, text });
  if (!tests.length) return guards.map((guard) => breach(guard, 'adds a guard, and this change touches no test that could fail without it'));
  const clone = scratchClone(root, range.head);
  try {
    if (!runTests(clone.checkout, tests)) return guards.map((guard) => breach(guard, `adds a guard whose tests fail at ${range.head.slice(0, 12)} even with it, so its loss proves nothing`));
    return guards.filter((guard) => {
      writeFileSync(join(clone.checkout, guard.path), `${guard.source.slice(0, guard.at)}void ${guard.source.slice(guard.at + 'throw'.length)}`);
      const survived = runTests(clone.checkout, tests);
      writeFileSync(join(clone.checkout, guard.path), guard.source);
      return survived;
    }).map((guard) => breach(guard, `adds a guard the change's tests still pass without: ${tests.join(', ')}`));
  } finally { clone.remove(); }
}

/**
 * The control rule for one fix: its test files, as the fix wrote them, must fail on its parent's
 * code and pass at the fix. A test that passes on both shows nothing about the cause.
 */
function controlBreaches(root, fix, runTests) {
  const diff = diffOf(root, fix.parent, fix.commit);
  const tests = changedTests(diff);
  if (!tests.length) return [{ ...firstChange(diff), text: `fix ${fix.commit.slice(0, 12)} has no control: it changes no test to run before and after it` }];
  const at = { path: tests[0], line: diff.get(tests[0]).added[0].line };
  if (!fix.parent) return [{ ...at, text: `fix ${fix.commit.slice(0, 12)} has no parent to run its control on` }];
  const clone = scratchClone(root, fix.parent);
  try {
    for (const path of tests) {
      mkdirSync(dirname(join(clone.checkout, path)), { recursive: true });
      writeFileSync(join(clone.checkout, path), textAt(root, fix.commit, path) ?? '');
    }
    const before = runTests(clone.checkout, tests);
    clone.move(fix.commit);
    const after = runTests(clone.checkout, tests);
    if (before) return [{ ...at, text: `fix ${fix.commit.slice(0, 12)}'s tests pass on its parent too, so they prove no root cause` }];
    if (!after) return [{ ...at, text: `fix ${fix.commit.slice(0, 12)}'s tests fail at the fix itself` }];
    return [];
  } finally { clone.remove(); }
}

/**
 * Every breach of the chosen rules in one change, sorted by path, line and rule.
 *
 * @param {string} root
 * @param {{ base: string, head: string }} range - from changeRange
 * @param {{ rules?: string[], budget?: number, runTests?: (cwd: string, files: string[]) => boolean }} [options]
 * @returns {{ rule: string, path: string, line: number, text: string }[]}
 */
export function qualityBreaches(root, range, { rules = QUALITY_RULES.map((rule) => rule.key), budget = GROWTH_BUDGET, runTests = nodeTests } = {}) {
  const unknown = rules.filter((key) => !CHECKS[key]);
  if (unknown.length) throw new Refused('RIGOR_RULE', `no quality rule named ${unknown.join(', ')}; use one of ${QUALITY_RULES.map((rule) => rule.key).join(', ')}`);
  const diff = range.base === range.head ? new Map() : diffOf(root, range.base, range.head);
  const order = (rule) => QUALITY_RULES.findIndex((entry) => entry.key === rule);
  return rules.flatMap((rule) => CHECKS[rule](root, range, { diff, budget, runTests }).map((breach) => ({ rule, ...breach })))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || order(a.rule) - order(b.rule));
}

/**
 * One breach as a problem line: its file and line, then the doctrine row that carries its rule
 * when the person has one, then the rule's key and what broke.
 *
 * @param {{ rule: string, path: string, line: number, text: string }} breach
 * @param {Map<string, string>} [rows] - rule key to doctrine row id
 * @returns {string}
 */
export function breachLine(breach, rows = new Map()) {
  const row = rows.get(breach.rule);
  return `${breach.path}:${breach.line}: ${row ? `${row} ` : ''}${breach.rule}: ${breach.text}`;
}
