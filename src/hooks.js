/**
 * The checks git runs (C1–C3, L3, L4): the commit message cites the spec, a lane's worktree stays in
 * its folders, no secret or env file is committed, and a push sends exactly what the gate checked.
 * Each check returns its problems; an empty list lets git go on.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitChildEnv, tryGit } from './git.js';
import { outOfLane } from './lanes.js';
import { citedIds, deletedIds, idProblems } from './spec.js';

export const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];
export const HOOKS_DIR = '.githooks';
export const HOOK_MARK = 'Installed by pullboard';
export const FIX_NOTE = 'Fix what each line names. Never work around a refusal with filler text.';

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣|️/u;
const EXEMPT_RE = /^(Merge |Revert "|fixup! |squash! |amend! )/;
const ZERO_SHA = /^0+$/;

/**
 * Secrets by kind, most specific first, so a line is named once by what it most likely is.
 */
const SECRETS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token or webhook', /xox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/],
  ['Stripe live key', /(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['Cloudflare token', /cfut_[A-Za-z0-9_-]{20,}/],
  ['npm token', /npm_[A-Za-z0-9]{36}/],
  ['assigned secret', /(api[_-]?key|secret|token|password)['"]?\s*[:=]\s*['"][A-Za-z0-9/+_=-]{20,}['"]/i],
  ['env-style secret', /^\s*(export\s+)?[A-Z][A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*[A-Za-z0-9/+_=-]{20,}\s*$/],
];

/**
 * Problems with a commit message's header: format, length, case, trailing period.
 *
 * @param {string} header
 * @param {any} rules
 * @returns {{ problems: string[], type: string }}
 */
function headerProblems(header, rules) {
  const typeRe = new RegExp(`^(${rules.types.join('|')})(\\([a-z0-9._/-]+\\))?(!)?: (.+)$`);
  const match = typeRe.exec(header);
  if (!match) {
    const merge = /^merge\b/i.test(header) ? '. For a merge, keep the message git writes, which is exempt: git merge --no-edit' : '';
    return {
      problems: [
        `write the header as type(scope): subject [ids], like "feat(store): save tasks to a file [G7]" (saw "${header.slice(0, 60)}"); types: ${rules.types.join(', ')}${merge}`,
      ],
      type: '',
    };
  }
  const subject = match[4].replace(/\s*\[[^\]]*\]\s*$/, '');
  const problems = [];
  if (header.length > rules.maxHeader) {
    problems.push(`shorten the header to ${rules.maxHeader} characters or fewer (it has ${header.length})`);
  }
  if (/^[A-Z]/.test(subject)) {
    problems.push(`start the subject with a lowercase letter (saw "${subject.slice(0, 30)}")`);
  }
  if (subject.endsWith('.')) problems.push('remove the period at the end of the subject');
  return { problems, type: match[1] };
}

/**
 * Every rule a commit message breaks (C1, C2). Merges, reverts and fixups git wrote are exempt.
 *
 * @param {string} raw - The message as git hands it, comments included.
 * @param {{ rules: any, spec: any }} context
 * @returns {string[]}
 */
export function commitMsgProblems(raw, { rules, spec, doctrine = null }) {
  const lines = raw.split('\n').filter((line) => !line.startsWith('#'));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const [header = '', second, ...body] = lines;
  if (EXEMPT_RE.test(header)) return [];
  const { problems, type } = headerProblems(header, rules);
  const ids = citedIds(header);
  problems.push(
    ...idProblems(spec, ids, doctrine).map(
      (problem) => `cite only rows that exist and are live, separated by commas like [G1,G2] (${problem})`,
    ),
  );
  if (type && rules.requireIds.includes(type) && !ids.length) {
    problems.push(
      `end the header with the spec rows this ${type} serves, like [G1,G2]; docs, test and chore commits may cite none`,
    );
  }
  if (second !== undefined && second.trim()) problems.push('leave a blank line after the header');
  const all = [header, ...body].join('\n');
  const words = new Set(all.toLowerCase().match(/[a-z]+/g) ?? []);
  for (const word of rules.banned) {
    if (words.has(word.toLowerCase())) problems.push(`drop the filler word "${word}"`);
  }
  if (rules.noEmoji && EMOJI_RE.test(all)) problems.push('remove the emoji');
  if (rules.noCoAuthor && /^\s*co-authored-by\s*:/im.test(all)) problems.push('remove the Co-Authored-By trailer');
  return problems;
}

/**
 * Colliding bare citations keep their SPEC.md meaning, but tell the author how to name doctrine.
 *
 * @param {string} raw
 * @param {{ spec: any, doctrine: any }} context
 * @returns {string[]}
 */
export function commitCitationWarnings(raw, { spec, doctrine }) {
  const ids = citedIds(raw.split('\n')[0] ?? '').filter((id) => !id.startsWith('doctrine:'));
  return ids.flatMap((id) => {
    const specRows = spec.rows.filter((row) => row.id === id);
    const doctrineRows = (doctrine?.repo?.rows ?? []).filter((row) => row.id === id);
    if (!specRows.length || specRows.length + doctrineRows.length < 2) return [];
    const specLocations = specRows.map((row) => `${spec.name ?? 'SPEC.md'}:${row.line}`);
    const doctrineLocations = doctrineRows.map((row) => `${doctrine.name}:${row.line}`);
    const locations = [...specLocations, ...doctrineLocations].slice(0, 2);
    const resolution = doctrineRows.length
      ? `bare ids cite SPEC.md, use doctrine:${id} for a doctrine row`
      : 'bare ids resolve to SPEC.md, which contains duplicate rows';
    return [`${id} is a known collision at ${locations.join(' and ')}; ${resolution}`];
  });
}

/**
 * Staged paths: every path the commit touches, and the ones it writes. An optional base lets a
 * merge check only differences from the merged commit. Deletions and both sides of a rename count
 * as touched, so a lane cannot delete or move a file it does not own (L3).
 *
 * @param {string} root
 * @param {string | null} [base]
 * @returns {{ touched: string[], written: string[] }}
 */
export function stagedPaths(root, base = null) {
  const fields = git(root, ['diff', '--cached', '--name-status', '-z', ...(base ? [base] : [])]).split('\0');
  const touched = [];
  const written = [];
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index] ?? '';
    const isMove = /^[RC]/.test(status);
    const paths = fields.slice(index + 1, index + (isMove ? 3 : 2));
    touched.push(...paths);
    if (!status.startsWith('D')) written.push(paths.at(-1) ?? '');
    index += isMove ? 3 : 2;
  }
  return { touched, written };
}

/**
 * The lines a staged diff adds, each with its file and line number.
 *
 * @param {string} diff - A zero-context unified diff.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function addedLines(diff) {
  const added = [];
  let path = '';
  let line = 0;
  for (const diffLine of diff.split('\n')) {
    if (diffLine.startsWith('+++ b/')) path = diffLine.slice(6);
    else if (diffLine.startsWith('@@ ')) line = Number(/\+(\d+)/.exec(diffLine)?.[1] ?? 0);
    else if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
      added.push({ path, line, text: diffLine.slice(1) });
      line += 1;
    }
  }
  return added;
}

/**
 * Added lines that look like secrets, named by kind and place. Values are never echoed back.
 *
 * @param {{ path: string, line: number, text: string }[]} added
 * @returns {string[]}
 */
export function secretsIn(added) {
  return added.flatMap((entry) => {
    const found = SECRETS.find(([, pattern]) => pattern.test(entry.text));
    return found ? [`${found[0]} at ${entry.path}:${entry.line}`] : [];
  });
}

/**
 * True when a file pattern matches a path: patterns with a slash match the whole path, others the
 * file name. `*` matches within one name.
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function matchesPattern(pattern, path) {
  const target = pattern.includes('/') ? path : (path.split('/').at(-1) ?? '');
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(target);
}

/**
 * Written paths that must never be committed: env files and whatever else the repo blocks.
 *
 * @param {string[]} paths
 * @param {{ blocked: string[], allowed: string[] }} protect
 * @returns {string[]}
 */
export function blockedPaths(paths, protect) {
  return paths.filter(
    (path) =>
      protect.blocked.some((pattern) => matchesPattern(pattern, path)) &&
      !protect.allowed.some((pattern) => matchesPattern(pattern, path)),
  );
}

/**
 * Every rule the staged change breaks (L3, L4): blocked files, secrets, and, in a lane's worktree,
 * changes outside its folders. The main checkout is the coordinator's and may change anything; any
 * other worktree must have joined a lane.
 *
 * @param {{ root: string, isMain: boolean, config: any, agent: any }} context
 * @returns {string[]}
 */
export function preCommitProblems({ root, isMain, config, agent }) {
  const { touched, written } = stagedPaths(root);
  const problems = blockedPaths(written, config.protect).map(
    (path) => `${path} is a blocked file (env or secrets); keep it out of git`,
  );
  if (config.protect.secrets) {
    const diff = git(root, ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0']);
    problems.push(...secretsIn(addedLines(diff)).map((where) => `possible secret: ${where}`));
  }
  problems.push(...deletedRowProblems(root, [config.spec, config.practice]));
  if (isMain) return problems;
  if (!agent) {
    problems.push('this worktree has not joined a lane: pullboard join <lane>');
    return problems;
  }
  const mergeBase = mainMergeBase(root);
  const ownershipTouched = mergeBase ? stagedPaths(root, mergeBase).touched : touched;
  const foreign = outOfLane(config, agent.agent_lane, ownershipTouched);
  problems.push(
    ...foreign.map((path) => `outside the ${agent.agent_lane} lane: ${path}; shout its owner instead`),
  );
  return problems;
}

/**
 * The commit being merged, only when it is already part of main's history.
 *
 * @param {string} root
 * @returns {string | null}
 */
function mainMergeBase(root) {
  const merge = tryGit(root, ['rev-parse', '--verify', 'MERGE_HEAD']);
  if (merge.status !== 0) return null;
  return tryGit(root, ['merge-base', '--is-ancestor', merge.stdout, 'refs/heads/main']).status === 0
    ? merge.stdout
    : null;
}

/**
 * A path quoted for the shell, whatever characters it holds.
 *
 * @param {string} text
 * @returns {string}
 */
const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Run the repo's fixers on the staged files they cover, and stage what they fixed (C5): a formatter
 * is a deterministic tool, so no agent should spend a turn running it, and none should fail a gate
 * on what a tool could have fixed. Only fully staged files are touched; fixing a partly staged one
 * would stage the hunks its author left out. A fixer that fails stages nothing, and the gate reports
 * what it could not fix.
 *
 * @param {string} root
 * @param {{ run: string, files?: string[] }[]} fixers
 * @returns {string[]} Notes for the person committing.
 */
export function applyFixers(root, fixers) {
  if (!fixers.length) return [];
  const { written } = stagedPaths(root);
  const unstaged = new Set(git(root, ['diff', '--name-only', '-z']).split('\0').filter(Boolean));
  const covers = (fixer, path) => (fixer.files ?? ['*']).some((pattern) => matchesPattern(pattern, path));
  const notes = [];
  for (const fixer of fixers) {
    const files = written.filter((path) => covers(fixer, path) && !unstaged.has(path) && existsSync(join(root, path)));
    if (!files.length) continue;
    const result = spawnSync(`${fixer.run} ${files.map(shellQuote).join(' ')}`, {
      cwd: root,
      env: gitChildEnv(root),
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.status === 0) git(root, ['add', '--', ...files]);
    else notes.push(`fixer "${fixer.run}" failed (${result.status ?? 'timed out'}); staged nothing from it, so the gate will name what it could not fix`);
  }
  const partly = written.filter((path) => unstaged.has(path) && fixers.some((fixer) => covers(fixer, path)));
  if (partly.length) notes.push(`not fixed, because they are partly staged: ${partly.join(', ')}`);
  return notes;
}

/**
 * Rows the staged change deletes from the spec or the practice (S8). Nobody is exempt, the
 * coordinator included: a commit or an item may cite any row, so a row that is cut stays, marked
 * wont (won't build) or retired.
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {string[]}
 */
export function deletedRowProblems(root, paths) {
  return paths.flatMap((path) => {
    const before = tryGit(root, ['show', `HEAD:${path}`]);
    if (before.status !== 0) return [];
    const staged = tryGit(root, ['show', `:${path}`]);
    if (staged.status !== 0) return [`${path} is deleted; ids are permanent: restore it`];
    return deletedIds(before.stdout, staged.stdout).map(
      (id) => `${path}: ${id} is gone; ids are permanent: keep the row and mark it wont (won't build) or retired`,
    );
  });
}

/**
 * Problems with a push (C3): uncommitted changes, or a ref that is not the checked-out commit, so
 * the gate that runs next checks exactly what leaves this machine.
 *
 * @param {string} root
 * @param {string} refsText - What git writes on the hook's stdin: one ref update per line.
 * @returns {string[]}
 */
export function prePushProblems(root, refsText) {
  if (tryGit(root, ['diff', '--quiet', 'HEAD']).status !== 0) {
    return ['commit or stash your changes first; the gate must check what you push'];
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const problems = [];
  for (const line of refsText.split('\n').filter((entry) => entry.trim())) {
    const [localRef = '', localSha = ''] = line.split(' ');
    if (ZERO_SHA.test(localSha)) continue;
    const commit = git(root, ['rev-parse', `${localSha}^{commit}`]);
    if (commit !== head) problems.push(`${localRef} is not checked out; switch to it and push from there`);
  }
  return problems;
}

/**
 * The shell script for one hook: it runs pullboard from this checkout's install, else the main
 * checkout's, which a fresh agent worktree shares, else the PATH.
 *
 * @param {string} hook
 * @returns {string}
 */
export function hookScript(hook) {
  const args = hook === 'commit-msg' ? ' "$1"' : '';
  return [
    '#!/bin/sh',
    `# ${HOOK_MARK}: runs the pullboard ${hook} checks. Edit pullboard.json, not this file.`,
    'root=$(git rev-parse --show-toplevel)',
    'main=$(git rev-parse --path-format=absolute --git-common-dir)/..',
    'for bin in "$root/node_modules/.bin/pullboard" "$main/node_modules/.bin/pullboard"; do',
    `  if [ -x "$bin" ]; then exec "$bin" hook ${hook}${args}; fi`,
    'done',
    `if command -v pullboard >/dev/null 2>&1; then exec pullboard hook ${hook}${args}; fi`,
    'echo "pullboard is not installed; npm i -D pullboard, or npm i -g pullboard" >&2',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Write the hook scripts and point git at them. A hook file pullboard did not write is left alone
 * and reported, so init never clobbers a repo's own hooks (I2).
 *
 * @param {string} root
 * @returns {string[]} What happened, one line per hook.
 */
export function installHooks(root) {
  const dir = join(root, HOOKS_DIR);
  mkdirSync(dir, { recursive: true });
  const notes = [];
  for (const hook of HOOKS) {
    const file = join(dir, hook);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (existing !== null && !existing.includes(HOOK_MARK)) {
      const isWired = existing.includes(`hook ${hook}`) && existing.includes('pullboard');
      notes.push(
        isWired
          ? `kept your ${HOOKS_DIR}/${hook} (it already runs pullboard)`
          : `kept your ${HOOKS_DIR}/${hook}; add a line to it: pullboard hook ${hook}`,
      );
      continue;
    }
    writeFileSync(file, hookScript(hook));
    chmodSync(file, 0o755);
    notes.push(`wrote ${HOOKS_DIR}/${hook}`);
  }
  const current = tryGit(root, ['config', '--get', 'core.hooksPath']).stdout;
  if (current && current !== HOOKS_DIR) {
    notes.push(`core.hooksPath is ${current}; left as is. Call pullboard hook <name> from those hooks`);
  } else {
    git(root, ['config', 'core.hooksPath', HOOKS_DIR]);
    notes.push(`set core.hooksPath to ${HOOKS_DIR}`);
  }
  return notes;
}
