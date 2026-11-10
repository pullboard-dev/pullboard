import { BOARD_PROOF_GUIDANCE } from "../../../config/index.js";
/**
 * The checks git runs (C1–C3, L3, L4): the commit message cites the spec, a lane's worktree stays in
 * its folders, no secret or env file is committed, and a push sends exactly what the gate checked.
 * Each check returns its problems; an empty list lets git go on.
 */
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import { gitExecFileSync } from "../../../git/index.js";
import { gitBoardDataPush } from "../logic/board.js";
import { rootTestRefusal } from './listing.js';
import { hostname } from 'node:os';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
  resolve,
} from 'node:path';
import {
  git,
  gitChildEnv,
  gitPath,
  gitConfig,
  invalidateGitFacts,
  mainCheckout,
  refuseGrafts,
  tryGit,
} from "../../../git/index.js";
import {
  CONFIG_FILE,
  configFromSource,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from "../../../config/index.js";
import { Refused } from "../../../kernel/index.js";
import { parseCommitMessage } from "../logic/message.js";
import { outOfLane } from "../../../seats/index.js";
import { movedImportOnlyChange } from "../logic/import-only-change.js";
import { movedImportTargets } from "../logic/import-only-change.js";
import { planRowChange } from "../logic/change/row/plan.js";
import { baselineRowChange } from "../logic/change/row/tier.js";
import { tierRowChange } from "../logic/change/row/tier.js";
import {
  citedIds,
  deletedIds,
  gateFiles,
  idProblems,
  parseSpec,
} from "../../../spec/index.js";
import { approvedRowProblems } from "../../../spec/index.js";
import { specGateMoveOnly } from "../../../spec/index.js";

export const HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'];
export const HOOKS_DIR = '.githooks';
export const HOOK_MARK = 'Installed by pullboard';
export const FIX_NOTE = 'Fix what each line names. Never work around a refusal with filler text.';

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣|️/u;
const EXEMPT_RE = /^(Merge |Revert "|fixup! |squash! |amend! )/;
const ZERO_SHA = /^0+$/;
const MAX_SECRET_DIFF_BYTES = 8 * 1024 * 1024;

/**
 * Secrets by kind, most specific first, so a line is named once by what it most likely is.
 */
const SECRETS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-proj-[A-Za-z0-9_-]{32,}/],
  ['OpenAI key', /(?<![A-Za-z0-9-])sk-(?:None-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token or webhook', /xox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/],
  ['Stripe live key', /(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['Cloudflare token', /cfut_[A-Za-z0-9_-]{20,}/],
  ['npm token', /npm_[A-Za-z0-9]{36}/],
  ['assigned secret', /(api[_-]?key|secret|token|password)['"]?\s*[:=]\s*['"]([A-Za-z0-9/+_=-]{20,})['"]/i],
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
        `write the header as type(scope): subject [ids] (saw "${header.slice(0, 60)}"); types: ${rules.types.join(', ')}${merge}`,
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

/** Name usable approved citations, or the real draft-and-approval path when none are available. */
function citationGuide(spec, type) {
  const ids = [...new Set(spec.rows.filter(row => row.status === 'approved')
    .map(row => row.id).filter(id => !idProblems(spec, [id]).length))].slice(0, 2);
  return ids.length
    ? `end the header with the spec rows this ${type} serves, like [${ids.join(',')}]; docs, test and chore commits may cite none`
    : `no approved spec row is available to cite; fenced format examples are not spec rows; run pullboard spec draft "<text>" for this requirement and cite the returned id now in this ${type || 'commit'} header; the person approves it in parallel`;
}

/**
 * Every rule a commit message breaks (C1, C2). Merges, reverts and fixups git wrote are exempt.
 *
 * @param {string} raw - The message as git hands it, comments included.
 * @param {{ rules: any, spec: any, doctrine?: any, claimedItems?: number[], rowlessLandings?: number[] }} context
 *   rowlessLandings: verified items citing no rows that a landing checkout may merge now.
 * @returns {string[]}
 */
export function commitMsgProblems(raw, { rules, spec, doctrine = null, claimedItems = [], rowlessLandings = [] }) {
  const lines = raw.split('\n').filter((line) => !line.startsWith('#'));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const [header = '', second, ...body] = lines;
  if (EXEMPT_RE.test(header)) return [];
  const { problems, type } = headerProblems(header, rules);
  const ids = citedIds(header);
  problems.push(
    ...idProblems(spec, ids, doctrine).map(
      (problem) => `cite only rows that exist and are live, separated by commas (${problem}); ${citationGuide(spec, type)}`,
    ),
  );
  const itemCitations = [...header.matchAll(/(?:^|\s)#([1-9]\d*)(?=\s|$)/gu)].map(match => Number(match[1]));
  const firstItem = !spec.rows.some(row => row.status === 'approved')
    && itemCitations.some(id => claimedItems.includes(id));
  // A generated landing message keeps a rowless item's own type (RFC 0005), so it has no ids to cite. Only a
  // landing checkout, merging a verified item the board says cites no rows, passes on its trailer.
  const landing = parseCommitMessage(lines.join('\n'));
  if (landing.trailers.some(entry => entry.key === 'Pullboard-Companion')) {
    problems.push('Pullboard-Companion is retired; generated commits use Pullboard-Item');
  }
  const rowlessLanding = landing.scope === 'merge' && landing.rows === null && rowlessLandings.includes(landing.item);
  if (type && rules.requireIds.includes(type) && !ids.length && !firstItem && !rowlessLanding) {
    problems.push(
      citationGuide(spec, type),
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
 * This machine's computer name as macOS shows it, or null when the platform has no such name or the
 * lookup fails. The lookup has a short timeout, so a stuck scutil cannot stall a submit (C1).
 *
 * @returns {string | null}
 */
export function computerName() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * This machine's names as a commit message would show them: the host name, its first label and the
 * computer name, matched case-insensitively. Names under three characters are ignored, so a short word
 * cannot refuse an honest message (C1). The sources are a parameter so a test can stand in for them.
 *
 * @param {{ host?: string, computer?: string | null }} [sources] - Defaults to this machine.
 * @returns {string[]} Lower-case names.
 */
export function machineNames(sources = { host: hostname(), computer: computerName() }) {
  const host = String(sources.host ?? '').trim().toLowerCase();
  const computer = String(sources.computer ?? '').trim().toLowerCase();
  return [...new Set([host, host.split('.')[0], computer])].filter((name) => name.length >= 3);
}

/**
 * Check the commits a submit adds for this machine's names in their messages (C1). With `refuse`, the
 * first named commit stops the submit and the next step says how to reword it; without, each named
 * commit is reported through `say` and the submit goes on. The names are never echoed, so the refusal
 * cannot leak them into a shout or a board thread.
 *
 * @param {string} root - The worktree the commits are in.
 * @param {string} range - The commits a submit adds, as `<trunk>..<head>`.
 * @param {{ refuse: boolean, say: (line: string) => void, names?: string[] }} options
 * @returns {void}
 */
export function machineNameProblems(root, range, { refuse, say, names = machineNames() }) {
  if (!names.length) return;
  // The SHAs come from rev-list and each message is read on its own, so no character in a message can
  // change where another message starts or ends.
  const shas = git(root, ['rev-list', range]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const message = git(root, ['log', '-1', '--format=%B', sha]);
    const lower = message.toLowerCase();
    if (!names.some((name) => lower.includes(name))) continue;
    const short = sha.slice(0, 12);
    if (refuse) {
      throw new Refused('HOST_NAME', `commit ${short} names this machine in its message; a submit may not publish that name`,
        `reword that commit's message without the machine's name, then run pullboard submit again`);
    }
    say(`warning: commit ${short} names this machine in its message; reword it before the branch is merged`);
  }
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
  const touched = [], companion = new Set(JSON.parse(process.env.PULLBOARD_HOOK_COMPANION_PATHS ?? '[]')); // #2593, #2614: a companion's own paths are exempt against the merged parent too
  const written = [];
  let index = 0;
  while (index < fields.length - 1) {
    const status = fields[index] ?? '';
    const isMove = /^[RC]/.test(status);
    const paths = fields.slice(index + 1, index + (isMove ? 3 : 2)).filter(path => !companion.has(path));
    touched.push(...paths);
    if (!status.startsWith('D') && paths.length) written.push(paths.at(-1));
    index += isMove ? 3 : 2;
  }
  return { touched, written };
}

/** The reads one pre-commit run shares, so git is asked once per kind of fact instead of once per path (#2232). */
let readCache = null;

/**
 * Run a check with shared git reads: one batched tree or index listing per revision, one resolve-undo
 * listing, one blob stream and one merge-base answer per head, however many paths it inspects.
 *
 * @template T
 * @param {string} root
 * @param {string[]} paths
 * @param {() => T} check
 * @returns {T}
 */
function withSharedReads(root, paths, check) {
  const outer = readCache;
  readCache = { root, paths: [...new Set(paths)], maps: new Map(), blobs: new Map(), undo: null, bases: new Map(), lines: undefined };
  try { return check(); } finally { readCache = outer; }
}

/** The shared reads for this root, or null outside a pre-commit run. */
const sharedReads = (root) => (readCache?.root === root ? readCache : null);

/** List the records of many literal paths at one revision in a few git calls. */
function fillRecords(root, revision, map, paths) {
  for (const path of paths) if (!map.has(path)) map.set(path, []);
  for (let start = 0; start < paths.length; start += 400) {
    const specs = paths.slice(start, start + 400).map((path) => `:(literal)${path}`);
    const raw = revision === ':index'
      ? git(root, ['ls-files', '--stage', '-z', '--', ...specs])
      : git(root, ['ls-tree', '-z', revision, '--', ...specs]);
    for (const record of raw.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      map.get(record.slice(tab + 1))?.push(record);
    }
  }
}

/**
 * The raw `ls-files --stage -z` (revision ':index') or `ls-tree -z` record text for one literal path,
 * the same bytes a single-path git call returns, served from the shared batch when one is running.
 */
function treeRaw(root, revision, path) {
  const shared = sharedReads(root);
  if (!shared) {
    return revision === ':index'
      ? git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`])
      : git(root, ['ls-tree', '-z', revision, '--', `:(literal)${path}`]);
  }
  let map = shared.maps.get(revision);
  if (!map) { map = new Map(); shared.maps.set(revision, map); fillRecords(root, revision, map, shared.paths); }
  if (!map.has(path)) fillRecords(root, revision, map, [path]);
  const records = map.get(path);
  return records.length ? `${records.join('\0')}\0` : '';
}

/** The resolve-undo records of one path, from one listing of the whole index per run. */
function resolveUndoRaw(root, path) {
  const shared = sharedReads(root);
  if (!shared) return git(root, ['ls-files', '--resolve-undo', '--stage', '-z', '--', ':(literal)' + path]);
  if (!shared.undo) {
    shared.undo = new Map();
    for (const record of git(root, ['ls-files', '--resolve-undo', '--stage', '-z']).split('\0').filter(Boolean)) {
      const key = record.slice(record.indexOf('\t') + 1);
      shared.undo.set(key, [...(shared.undo.get(key) ?? []), record]);
    }
  }
  return (shared.undo.get(path) ?? []).join('\0');
}

/** Merge bases of HEAD and one merge head, asked once per head. */
function mergeBasesOf(root, mergeHead) {
  const shared = sharedReads(root);
  const ask = () => tryGit(root, ['merge-base', '--all', 'HEAD', mergeHead]);
  if (!shared) return ask();
  if (!shared.bases.has(mergeHead)) shared.bases.set(mergeHead, ask());
  return shared.bases.get(mergeHead);
}

/** Load the blobs of many object ids with one `cat-file --batch`; ids it cannot serve fall back to single reads. */
function prefetchBlobs(root, oids) {
  const shared = sharedReads(root);
  const wanted = [...new Set(oids)].filter((oid) => shared && !shared.blobs.has(oid));
  if (!wanted.length) return;
  let out;
  try {
    out = gitExecFileSync(['cat-file', '--batch'], {
      cwd: root, env: gitChildEnv(root), input: `${wanted.join('\n')}\n`, encoding: null, maxBuffer: 256 * 1024 * 1024,
    });
  } catch { return; }
  let at = 0;
  for (const oid of wanted) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) return;
    const header = out.toString('utf8', at, end).split(' ');
    if (header[1] !== 'blob') { at = end + 1; continue; }
    const size = Number(header[2]);
    shared.blobs.set(oid, size <= 8 * 1024 * 1024 ? out.subarray(end + 1, end + 1 + size) : null);
    at = end + 1 + size + 1;
  }
}

/** Read one exact blob header from the index or a committed tree, refusing paths and modes that are not plain files. */
function importFileEntry(root, revision, path) {
  const raw = treeRaw(root, revision, path);
  if (!raw.endsWith('\0') || raw.slice(0, -1).includes('\0')) return null;
  const row = raw.slice(0, -1);
  const tab = row.indexOf('\t');
  if (tab < 0 || row.slice(tab + 1) !== path) return null;
  const fields = row.slice(0, tab).split(' ');
  const [mode, type, object] = fields;
  if (mode !== '100644' && mode !== '100755') return null;
  if (revision === ':index' ? fields.length !== 3 || object !== '0' : type !== 'blob') return null;
  const oid = revision === ':index' ? type : object;
  return /^[a-f0-9]{40,64}$/u.test(oid ?? '') ? { mode, oid } : null;
}

/** Read one bounded text blob by its already parsed object identity. */
function importFileBlob(root, oid) {
  const shared = sharedReads(root);
  if (shared?.blobs.has(oid)) return shared.blobs.get(oid);
  try {
    const bytes = gitExecFileSync(['cat-file', 'blob', oid], {
      cwd: root, env: gitChildEnv(root), encoding: null, maxBuffer: 8 * 1024 * 1024,
    });
    return Buffer.isBuffer(bytes) && bytes.length <= 8 * 1024 * 1024 ? bytes : null;
  } catch { return null; }
}

/** Compare a foreign staged path with one exact parent, preserving mode and moved-import proof. */
function stagedImportOnlyChange(root, path, moves, parent = 'HEAD') {
  const before = importFileEntry(root, parent, path);
  const after = importFileEntry(root, ':index', path);
  if (!before || !after || before.mode !== after.mode) return false;
  return movedImportOnlyChange(importFileBlob(root, before.oid), importFileBlob(root, after.oid), path, moves);
}

/** Name added source lines when a foreign staged edit is outside the mechanical import allowance. */
function stagedChangedLines(root, path) {
  const shared = sharedReads(root);
  if (shared) {
    if (shared.lines === undefined) {
      try {
        const rows = addedLines(shared.diff ?? git(root, ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0'], { maxBuffer: MAX_SECRET_DIFF_BYTES }));
        shared.lines = new Map();
        for (const row of rows) shared.lines.set(row.path, [...(shared.lines.get(row.path) ?? []), `${row.path}:${row.line}`]);
      } catch { shared.lines = null; }
    }
    // A path with no added rows (an exact rename, a mode change) keeps its own single-path read.
    if (shared.lines?.has(path)) return shared.lines.get(path);
    if (shared.lines && !treeRaw(root, ':index', path)) return [];
  }
  try {
    const diff = git(root, ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', '--', ':(literal)' + path], { maxBuffer: MAX_SECRET_DIFF_BYTES });
    return addedLines(diff).filter(row => row.path === path).map(row => `${path}:${row.line}`);
  } catch { return []; }
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

/** Recognize only the complete public negative-auth object property, never a literal prefix or continuation. */
function publicFixtureAssignment(match, text) {
  return /^secret[ \t]*:[ \t]*(['"])not-the-listener-secret\1$/u.test(match[0])
    && /[{,][ \t]*$/u.test(text.slice(0, match.index))
    && /^[ \t]*\}/u.test(text.slice(match.index + match[0].length));
}

/**
 * Added lines that look like secrets, named by kind and place. Values are never echoed back.
 *
 * @param {{ path: string, line: number, text: string }[]} added
 * @returns {string[]}
 */
export function secretsIn(added) {
  return added.flatMap((entry) => {
    const found = SECRETS.find(([kind, pattern]) => kind === 'assigned secret'
      // This public negative-auth fixture predates history transfer; it is never a credential.
      // Inspect every assignment so the sentinel cannot conceal a second value on the same line.
      ? [...entry.text.matchAll(new RegExp(pattern.source, 'gi'))]
        .some(match => !publicFixtureAssignment(match, entry.text))
      : pattern.test(entry.text));
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
 * @param {{ root: string, isMain: boolean, config: any, agent: any, boardFile?: string, preMergeHook?: boolean, onNotice?: (message: string) => void, approvedRowPorts: any }} context
 * @returns {string[]}
 */
export function preCommitProblems(context) {
  return withSharedReads(context.root, stagedPaths(context.root).touched, () => checkStagedChange(context));
}

/** The body of preCommitProblems, run with the shared git reads open (#2232). */
function checkStagedChange({ root, isMain, config, agent, boardFile, preMergeHook = false, onNotice, approvedRowPorts, shimImports }) {
  if (!isMain) refuseGrafts(root);
  const { touched, written } = stagedPaths(root);
  const touchedPaths = new Set(touched), writtenPaths = new Set(written);
  const problems = blockedPaths(written, config.protect).map(
    (path) => `${path} is a blocked file (env or secrets); keep it out of git`,
  );
  if (config.protect.secrets) {
    let added;
    const resolution = isMain ? null : trunkMergeResolution(root, preMergeHook);
    try {
      if (resolution) added = resolution();
      else {
        const diff = git(root, ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0'], { maxBuffer: MAX_SECRET_DIFF_BYTES });
        if (readCache) readCache.diff = diff;
        added = addedLines(diff);
      }
    } catch (error) {
      if (error.code !== 'ENOBUFS') throw error;
      added = addedLinesInBatches(root, written);
    }
    problems.push(...secretsIn(added).map((where) => `possible secret: ${where}`));
  }
  problems.push(...deletedRowProblems(root, [config.spec, config.practice]), ...deletedGateProblems(root, config));
  const rootTests = rootTestRefusal(written, { isTest: path => (config.claim?.barTestFiles ?? []).some(pattern => matchesPattern(pattern.split('/').at(-1), path)), known: path => ['HEAD', 'refs/heads/main'].some(revision => tryGit(root, ['cat-file', '-e', `${revision}:${path}`]).status === 0), read: path => { const shown = tryGit(root, ['show', `:${path}`]); return shown.status === 0 ? shown.stdout : null; } }); if (rootTests) throw new Refused(rootTests.code, rootTests.message, rootTests.next); // #4005
  problems.push(...approvedRowProblems(root, config, boardFile, approvedRowPorts));
  if (shimImports) {
    const revisions = new Map();
    problems.push(...shimImports({ paths: written,
      read: (revision, path) => {
        // An initial commit has an index but no HEAD; do not invent historical source or read the worktree.
        if (revision !== ':index') {
          if (!revisions.has(revision)) revisions.set(revision, tryGit(root, ['rev-parse', '--verify', revision]).status === 0);
          if (!revisions.get(revision)) return undefined;
        }
        const entry = importFileEntry(root, revision, path);
        if (!entry) return undefined;
        const bytes = importFileBlob(root, entry.oid);
        if (bytes === null) throw new Refused('SHIM_IMPORT_INPUT', `cannot analyze the staged source blob ${path}; split it into bounded modules`);
        return bytes.toString('utf8');
      } }));
  }
  if (isMain) return problems;
  if (!agent) {
    problems.push('this worktree has not joined a lane: pullboard join <lane> --model "<model name>"');
    return problems;
  }
  const mergeHeads = mainMergeHeads(root, preMergeHook);
  const ownershipConfig = committedLaneConfig(root);
  const mergeTouched = mergeHeads ? [...new Set([...touched, ...mergeHeads.flatMap((mergeHead) => stagedPaths(root, mergeHead).touched)])] : touched;
  if (readCache) readCache.paths = [...new Set([...readCache.paths, ...mergeTouched])];
  // Keeping either parent's exact content of a foreign file is accepted unchanged; when that file had a real conflict
  // in this merge, the resolution still names its owner (#860).
  const kept = mergeHeads && !preMergeHook
    ? mergeTouched.filter((path) => outOfLane(ownershipConfig, agent.agent_lane, [path]).length && unchangedMergePath(root, path, mergeHeads) && conflictedInMerge(root, path))
    : [];
  kept.forEach((path) => onNotice?.(`resolved accepted-main conflict in ${path}; the coordinator owns ${path}`));
  const ownershipTouched = mergeHeads
    ? mergeTouched.filter((path) => !outOfLane(ownershipConfig, agent.agent_lane, [path]).length || !unchangedMergePath(root, path, mergeHeads))
    : touched;
  const mainOnlyStaged = mergeHeads ? new Set() : stagedMainOnlyPaths(root, ownershipTouched);
  const foreignPaths = ownershipTouched.filter((path) => !mainOnlyStaged.has(path)
    && outOfLane(ownershipConfig, agent.agent_lane, [path]).length);
  const resolved = mergeHeads && !preMergeHook
    ? foreignPaths.filter((path) => resolvedMergeConflictPath(root, path, mergeHeads))
    : [];
  resolved.forEach((path) => onNotice?.(`resolved accepted-main conflict in ${path}; the coordinator owns ${path}`));
  const checkedForeign = foreignPaths.filter((path) => !resolved.includes(path)
    && !(path === ownershipConfig.spec && specGateMoveOnly(root, path)));
  /** Read exact index or HEAD blobs, never unstaged worktree bytes. */
  const planRead = (revision, path) => {
    const entry = importFileEntry(root, revision, path);
    return entry && { ...entry, bytes: importFileBlob(root, entry.oid) };
  };
  prefetchBlobs(root, checkedForeign.flatMap(path => ['HEAD', ':index'].map(revision => importFileEntry(root, revision, path)?.oid).filter(Boolean)));
  const planChanges = new Map(checkedForeign.map(path => [path, planRowChange(path, {
    before: path => planRead('HEAD', path), after: path => planRead(':index', path),
    ownNewFile: path => !outOfLane(ownershipConfig, agent.agent_lane, [path]).length
      && ((writtenPaths.has(path) && Boolean(importFileEntry(root, ':index', path)))
        || (!touchedPaths.has(path) && Boolean(treeRaw(root, 'HEAD', path)))),
  })]));
  const tierChanges = new Map(checkedForeign.map(path => [path, tierRowChange(path, {
    before: path => planRead('HEAD', path), after: path => planRead(':index', path),
    ownsFile: file => !outOfLane(ownershipConfig, agent.agent_lane, [file]).length,
  })]));
  const baselineChanges = new Map(checkedForeign.map(path => [path, baselineRowChange(path, {
    before: path => planRead('HEAD', path), after: path => planRead(':index', path),
    ownsFile: file => !outOfLane(ownershipConfig, agent.agent_lane, [file]).length,
  })]));
  const moves = movedImportTargets(git(root, ['diff', '--cached', '--name-status', '-z', '-M']),
    path => { const entry = importFileEntry(root, 'HEAD', path); return entry && importFileBlob(root, entry.oid); },
    path => Boolean(importFileEntry(root, ':index', path)));
  // A shim may have been deleted on this branch before main was merged; derive its move from
  // each accepted merge parent as well as HEAD, then compare the staged file to that same parent.
  const mergeMoves = (mergeHeads ?? []).map(parent => ({ parent, moves: movedImportTargets(
    git(root, ['diff', '--cached', '--name-status', '-z', '-M', parent]),
    path => { const entry = importFileEntry(root, parent, path); return entry && importFileBlob(root, entry.oid); },
    path => Boolean(importFileEntry(root, ':index', path)),
  ) }));
  const mechanical = checkedForeign.filter(path => stagedImportOnlyChange(root, path, moves)
    || mergeMoves.some(({ parent, moves: parentMoves }) => stagedImportOnlyChange(root, path, parentMoves, parent))
    || planChanges.get(path).allowed || tierChanges.get(path).allowed || baselineChanges.get(path).allowed);
  for (const path of mechanical) onNotice?.(`cross-lane mechanical ${planChanges.get(path).allowed ? 'new-file placement' : tierChanges.get(path).allowed ? 'own-lane tier row' : baselineChanges.get(path).allowed ? 'own-lane baseline row' : 'import edit'}: ${JSON.stringify(path)}; this path will be flagged for the reviewer on submit`);
  problems.push(...checkedForeign.filter(path => !mechanical.includes(path))
    .flatMap((path) => outOfLane(ownershipConfig, agent.agent_lane, [path]).map(label => ({ path, label })))
    .map(({ path, label }) => {
      const lines = stagedChangedLines(root, path);
      return `outside the ${agent.agent_lane} lane: ${label}; shout its owner instead${lines.length ? `; changed at ${lines.join(', ')}` : ''}${planChanges.get(path).problem || tierChanges.get(path).problem || baselineChanges.get(path).problem ? ` (${planChanges.get(path).problem ?? tierChanges.get(path).problem ?? baselineChanges.get(path).problem})` : ''}; only exact moved-file or deleted-shim path updates, or canonical rows for owned new files, are permitted mechanically`;
    }));
  return problems;
}

/**
 * A commit that deletes or changes a renamed test file an approved must-row names must point that row at its new
 * home in the same commit, or the rule loses its test silently (#809). The row is read from HEAD's spec
 * and again from the staged one, so a repoint in this commit counts and a missing row does not.
 *
 * @param {string} root
 * @param {{ spec?: string }} config
 * @returns {string[]}
 */
export function deletedGateProblems(root, config) {
  if (!config?.spec) return [];
  const status = tryGit(root, ['diff', '--cached', '--name-status', '-M', '--no-color']);
  if (status.status !== 0) return [];
  const gone = new Map();
  for (const line of status.stdout.split('\n').filter(Boolean)) {
    const [code, from, to] = line.split('\t');
    if (code.startsWith('D')) gone.set(from, 'deletes');
    else if (code.startsWith('R')) {
      const before = tryGit(root, ['rev-parse', `HEAD:${from}`]);
      const after = tryGit(root, ['rev-parse', `:${to}`]);
      if (before.status !== 0 || after.status !== 0 || before.stdout.trim() !== after.stdout.trim()) gone.set(from, `renames to ${to} with changed content`);
    }
  }
  if (!gone.size) return [];
  const head = tryGit(root, ['show', `HEAD:${config.spec}`]);
  if (head.status !== 0) return [];
  const staged = tryGit(root, ['show', `:${config.spec}`]);
  const before = parseSpec(head.stdout).rows.filter((row) => row.status === 'approved' && row.tier === 'must');
  const after = staged.status === 0 ? parseSpec(staged.stdout).rows : [];
  const problems = [];
  for (const [file, change] of gone) {
    for (const row of before) {
      if (!gateFiles(row.gate).includes(file)) continue;
      const now = after.find((candidate) => candidate.id === row.id);
      if (now && !gateFiles(now.gate).includes(file)) continue;
      problems.push(`${row.id} names ${file}, which this commit ${change}; point ${row.id} at its new home in this commit`);
    }
  }
  return problems;
}

/** Read lane ownership from the committed checkout, so unstaged settings cannot grant new folders [L1,L3]. */
function committedLaneConfig(root) {
  const source = tryGit(root, ['show', 'HEAD:' + CONFIG_FILE]);
  if (source.status !== 0) throw new Refused('NO_POLICY', 'lane checks need pullboard.json committed at HEAD; restore the committed policy or ask the coordinator to initialize it');
  return configFromSource(source.stdout);
}

/** Report a missing merge check at Git's effective hook path without changing files [L3,A6]. */
export function preMergeHookProblems(root) {
  const file = gitPath(root, 'hooks/pre-merge-commit');
  return existsSync(file) ? [] : [{ code: 'HOOK_MISSING', message: `merge hook ${file} is missing`, next: 'run pullboard hooks to install pre-merge-commit, then commit the hook files' }];
}

/** Resolve Git's effective hook directory, letting Git apply core.hooksPath itself.
 *
 * @param {string} root
 * @returns {string}
 */
function activeHooksDir(root) {
  return resolve(root, gitPath(root, 'hooks'));
}

/** Read a here-document delimiter without treating its quoted spelling as executable code. */
function hookHeredoc(text, start) {
  let end = start + 2;
  const stripTabs = text[end] === '-';
  if (stripTabs) end++;
  while (text[end] === ' ' || text[end] === '\t') end++;
  const wordStart = end;
  let delimiter = '';
  let quote = '';
  while (end < text.length) {
    const char = text[end];
    if (!quote && /[\s;&|()<>]/u.test(char)) break;
    if (char === '\\' && quote !== "'") {
      if (end + 1 >= text.length || text[end + 1] === '\n') return null;
      delimiter += text[++end]; end++; continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else delimiter += char;
    } else if (char === "'" || char === '"') quote = char;
    else delimiter += char;
    end++;
  }
  return end > wordStart && !quote ? { end, delimiter, stripTabs } : null;
}

/** Skip here-document bodies in shell order; printed examples cannot establish hook wiring. */
function skipHookHeredocs(text, start, documents) {
  let cursor = start;
  for (const { delimiter, stripTabs } of documents) {
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const line = text.slice(cursor, newline < 0 ? text.length : newline);
      cursor = newline < 0 ? text.length : newline + 1;
      if ((stripTabs ? line.replace(/^\t*/u, '') : line) === delimiter) break;
    }
  }
  return cursor;
}

/** Split hook shell commands without treating quoted examples, comments or heredocs as invocations. */
function hookCommands(source) {
  const text = source.replace(/\\\r?\n/gu, '');
  const commands = [];
  const documents = [];
  let command = '';
  let quote = '';
  let escaped = false;
  let comment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
    }
    if (escaped) { command += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { command += char; escaped = true; continue; }
    if (quote) { command += char; if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; command += char; continue; }
    if (char === '#' && (!command || /\s$/u.test(command))) { comment = true; continue; }
    if (char === '<' && text[index + 1] === '<' && text[index - 1] !== '<' && text[index + 2] !== '<') {
      const here = hookHeredoc(text, index);
      if (here) {
        documents.push(here); command += text.slice(index, here.end); index = here.end - 1; continue;
      }
    }
    if (/[\n;&|()]/u.test(char)) {
      commands.push(command.trim()); command = '';
      if (char === '\n' && documents.length) {
        index = skipHookHeredocs(text, index + 1, documents) - 1;
        documents.length = 0;
      }
      continue;
    }
    command += char;
  }
  commands.push(command.trim());
  return commands.filter(Boolean);
}

/** Recognize direct, quoted-path and generated-variable calls without executing a hook. */
function delegatesHook(source, hook) {
  const commands = hookCommands(source);
  const program = String.raw`(?:"(?:[^"]*/)?pullboard(?:\.js)?"|'(?:[^']*/)?pullboard(?:\.js)?'|(?:[^\s"';&|()]+/)?pullboard(?:\.js)?)`;
  const binBinding = new RegExp(`^(?:bin=|for\\s+bin\\s+in\\s+)${program}(?=\\s|$)`);
  const boundBin = commands.some(command => binBinding.test(command));
  // env consumes NAME=value arguments before its executable, including quoted and empty values.
  const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"';&|()])*`;
  const prefix = String.raw`(?:(?:then|do|else|exec|command|npx|node)\s+|env\s+(?:${assignment}\s+)*)*`;
  const call = new RegExp(`^${prefix}(?:${program}${boundBin ? '|"?\\$bin"?' : ''})\\s+hook\\s+${hook}(?=\\s|$)`);
  return commands.some(command => call.test(command));
}

/** Report active Git hooks that do not delegate to Pullboard, without changing hook files [L3].
 *
 * @param {string} root
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function unwiredHookProblems(root) {
  const dir = activeHooksDir(root);
  return HOOKS.flatMap((hook) => {
    const file = join(dir, hook);
    let source;
    try {
      if ((statSync(file).mode & 0o111) === 0) return [];
      source = readFileSync(file, 'utf8');
    } catch { return []; }
    if (delegatesHook(source, hook)) return [];
    const path = relative(root, file);
    return [{
      code: 'HOOK_UNWIRED',
      message: `active Git hook ${path} does not call pullboard hook ${hook}`,
      next: `add this line: pullboard hook ${hook} "$@"`,
    }];
  });
}

/**
 * Validate incoming commit candidates against primary main, using Git's pre-MERGE_HEAD inputs only
 * for the merge hook; GITHEAD is ordinary environment data, not proof of who invoked this hook.
 *
 * @param {string} root
 * @param {boolean} preMergeHook Whether the CLI was invoked for pre-merge-commit.
 * @returns {string[] | null}
 */
function mainMergeHeads(root, preMergeHook) {
  const gitPath = tryGit(root, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  if (gitPath.status !== 0) return null;
  let merges;
  const mergeFile = resolve(root, gitPath.stdout.trim());
  try {
    if (existsSync(mergeFile)) merges = readFileSync(mergeFile, 'utf8').split(/\r?\n/u).filter(Boolean);
    else if (preMergeHook) {
      const names = Object.keys(process.env).filter((name) => name.startsWith('GITHEAD_'));
      if (names.some((name) => !/^GITHEAD_(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(name))) return null;
      merges = names.map((name) => name.slice('GITHEAD_'.length));
    } else return null;
  } catch { return null; }
  if (!merges.length || merges.some((merge) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(merge))) return null;
  merges = [...new Set(merges)];
  for (const merge of merges) {
    if (tryGit(root, ['cat-file', '-e', `${merge}^{commit}`]).status !== 0) return null;
    if (tryGit(root, ['merge-base', '--is-ancestor', merge, 'HEAD']).status !== 1) return null;
  }
  let main;
  try { main = mainCheckout(root)?.commit; } catch { return null; }
  if (!main) return null;
  return merges.every((merge) => tryGit(root, ['merge-base', '--is-ancestor', merge, main]).status === 0)
    ? merges
    : null;
}

/**
 * For a merge whose only other parent is the trunk, a reader of the resolution: the staged lines found in
 * neither parent's version of a path both parents changed. Trunk content was scanned when it landed on main and
 * branch content when it was committed, so the secret scan reads only these lines, whatever either side added
 * to the same file. Null for any other commit, which is scanned in full. Why: a long-lived branch merging main
 * would otherwise exceed the scan limit on trunk content alone (#3762).
 *
 * @param {string} root
 * @param {boolean} preMergeHook
 * @returns {(() => { path: string, line: number, text: string }[]) | null}
 */
function trunkMergeResolution(root, preMergeHook) {
  const heads = mainMergeHeads(root, preMergeHook);
  if (!heads || heads.length !== 1) return null;
  const names = (base) => git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', base, '--'], { maxBuffer: MAX_SECRET_DIFF_BYTES })
    .split('\0').filter(Boolean);
  return () => {
    const fromTrunk = new Set(names(heads[0]));
    const blob = (spec) => {
      try { return git(root, ['cat-file', 'blob', spec], { maxBuffer: 32 * MAX_SECRET_DIFF_BYTES }); }
      catch (error) { if (error.code === 'ENOBUFS') throw error; return ''; } // no such blob: the path is new on that side
    };
    let bytes = 0;
    return names('HEAD').filter((path) => fromTrunk.has(path)).flatMap((path) => {
      const known = new Set([...blob('HEAD:' + path).split('\n'), ...blob(heads[0] + ':' + path).split('\n')]);
      return blob(':' + path).split('\n')
        .map((text, index) => ({ path, line: index + 1, text }))
        .filter((entry) => !known.has(entry.text))
        .map((entry) => {
          bytes += entry.text.length + 1;
          // The resolution is bounded like any other scanned diff.
          if (bytes > MAX_SECRET_DIFF_BYTES) throw Object.assign(new Error('resolution exceeds the scan limit'), { code: 'ENOBUFS' });
          return entry;
        });
    });
  };
}

/** Compare the staged mode and object, rejecting unresolved stages rather than treating them as deletions. */
function stagedObject(root, path) {
  const records = treeRaw(root, ':index', path).split('\0').filter((record) => {
    const separator = record.indexOf('\t');
    return separator !== -1 && record.slice(separator + 1) === path;
  });
  if (!records.length) return '';
  if (records.length !== 1) return null;
  const fields = /^(\d{6}) ([0-9a-f]{40,64}) 0\t/.exec(records[0]);
  return fields ? fields[1] + ' ' + fields[2] : null;
}

/** Read one committed path's mode and object without following symlinks or interpreting filename globs. */
function committedObject(root, commit, path) {
  const records = treeRaw(root, commit, path).split('\0').filter(Boolean);
  if (!records.length) return '';
  if (records.length !== 1) return null;
  const fields = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t/.exec(records[0]);
  return fields ? fields[1] + ' ' + fields[2] : null;
}

/** Identify staged foreign files that match accepted main or its merge-base ancestry. */
function stagedMainOnlyPaths(root, paths) {
  let main;
  try { main = mainCheckout(root)?.commit; } catch { return new Set(); }
  if (!main) return new Set();
  const result = tryGit(root, ['merge-base', '--all', main, 'HEAD']);
  if (result.status !== 0) return new Set();
  const bases = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  return new Set(paths.filter(path => {
    const staged = stagedObject(root, path);
    if (staged === null) return false;
    if (staged === committedObject(root, main, path)) return true;
    return bases.length > 0 && bases.every(base => staged === committedObject(root, base, path));
  }));
}

/** Main integration may preserve either parent's exact foreign object. */
function unchangedMergePath(root, path, mergeHeads) {
  const staged = stagedObject(root, path);
  return staged !== null && (mergeHeads.some((mergeHead) => staged === committedObject(root, mergeHead, path)) || staged === committedObject(root, 'HEAD', path));
}

/** Whether Git's resolve-undo index records a real conflict for this path in the merge being committed. */
function conflictedInMerge(root, path) {
  return resolveUndoRaw(root, path).split('\0').filter(Boolean)
    .some((record) => record.slice(record.indexOf('\t') + 1) === path && /^\d{6} [0-9a-f]{40,64} [123]\t/iu.test(record));
}

/**
 * Allow a new foreign object, or the file's removal, only when Git records both exact parents in the
 * resolved conflict index. Removing the file is a resolution like any other (#860): `git rm` after a
 * real conflict leaves no staged entry, so a missing side compares as absent rather than refusing.
 */
function resolvedMergeConflictPath(root, path, mergeHeads) {
  const staged = stagedObject(root, path);
  if (staged === null) return false;
  const removed = staged === '';
  const records = resolveUndoRaw(root, path).split('\0').filter(Boolean);
  const stages = new Map();
  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator === -1 || record.slice(separator + 1) !== path) continue;
    const fields = /^(\d{6}) ([0-9a-f]{40,64}) ([0123])$/iu.exec(record.slice(0, separator));
    if (fields?.[3] === '0') {
      if (removed || fields[1] + ' ' + fields[2] !== staged) return false;
      continue;
    }
    if (!fields || stages.has(fields[3])) return false;
    stages.set(fields[3], fields[1] + ' ' + fields[2]);
  }
  const bases = mergeHeads.flatMap((mergeHead) => {
    const result = mergeBasesOf(root, mergeHead);
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
  });
  if (!bases.length) return false;
  const baseStage = stages.get('1');
  const hasBaseProvenance = baseStage
    ? bases.some((base) => baseStage === committedObject(root, base, path))
    : bases.every((base) => committedObject(root, base, path) === '');
  const parentModes = [stages.get('2'), stages.get('3')].filter(Boolean).map((entry) => entry.split(' ', 1)[0]);
  // A side the conflict lacks, as in modify/delete, is the parent's absent path, compared as ''.
  return (stages.has('2') || stages.has('3')) && hasBaseProvenance
    && (stages.get('2') ?? '') === committedObject(root, 'HEAD', path)
    && mergeHeads.some((mergeHead) => (stages.get('3') ?? '') === committedObject(root, mergeHead, path))
    && (removed || parentModes.includes(staged.split(' ', 1)[0]));
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
    invalidateGitFacts();
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
    const names = [DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(path)
      ? [path, path === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE]
      : [path];
    const before = names.map((name) => ({ ...tryGit(root, ['show', `HEAD:${name}`]), name })).find((file) => file.status === 0);
    if (!before) return [];
    const staged = names.map((name) => ({ ...tryGit(root, ['show', `:${name}`]), name })).find((file) => file.status === 0);
    if (!staged) return [`${before.name} is deleted; ids are permanent: restore it`];
    return deletedIds(before.stdout, staged.stdout).map(
      (id) => `${staged.name}: ${id} is gone; ids are permanent: keep the row and mark it wont (won't build) or retired`,
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
  if (gitBoardDataPush(root, refsText)) return [];
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

/** Whether Git's pre-push updates advance the configured trunk rather than another remote branch. */
export function pushesTrunk(refsText, trunk) {
  if (!trunk) return false;
  const remoteTrunk = trunk.startsWith('refs/heads/') ? trunk : `refs/heads/${trunk}`;
  return refsText.split('\n').some((line) => {
    const [, localSha = '', remoteRef = ''] = line.trim().split(/\s+/u);
    return remoteRef === remoteTrunk && !ZERO_SHA.test(localSha);
  });
}

let cachedInstallerVersion;

/** Read installer metadata only when generating a hook, so importing board helpers needs no package. */
function installerVersion() {
  return cachedInstallerVersion ??= JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), 'utf8')).version;
}

/**
 * The shell script for one hook: it runs pullboard from this checkout's install, else the main
 * checkout's, which a fresh agent worktree shares, else the PATH.
 *
 * The script carries the version that wrote it and asks the binary it found for its own before running
 * any rule (#876): an older global install would otherwise apply its old rules under a newer CLI's
 * guidance, and an old binary cannot be trusted to notice. A mismatch stops the hook, names both
 * versions, and gives the one command that fixes it: install the hook's version (project or global, where
 * the binary came from) when the found one is older, or rewrite the hooks with `pullboard init` when newer.
 *
 * @param {string} hook
 * @param {string} [version] The installing version; tests pass their own.
 * @returns {string}
 */
export function hookScript(hook, version = installerVersion()) {
  const args = hook === 'commit-msg' ? ' "$message"' : '';
  return [
    '#!/bin/sh',
    `# ${HOOK_MARK}: runs the pullboard ${hook} checks. Edit pullboard.json, not this file.`,
    '# Run tests with pullboard test <test files>: the runner pool first, the per-file timeout, and known main failures named.',
    `# ${BOARD_PROOF_GUIDANCE}`,
    `want='${version}'`,
    ...(hook === 'commit-msg' ? ['message="$1"'] : []),
    'root=$(git rev-parse --show-toplevel)',
    'main=$(git rev-parse --path-format=absolute --git-common-dir)/..',
    'run() {',
    '  bin="$1"; scope="$2"',
    // Shell builtins only, so a hook works on a PATH that has no tail or sed: keep the last line of --version.
    // The probe gets EOF; the delegated pre-push hook must receive Git's original ref records.
    // A failed probe already explains its refusal on stderr; preserve stdout refusals too, without guessing a version.
    '  have=$("$bin" --version </dev/null) || {',
    '    [ -z "$have" ] || printf \'%s\\n\' "$have" >&2',
    '    exit 1',
    '  }',
    '  nl=$(printf \'\\n_\'); nl=${nl%_}; have=${have##*"$nl"}',
    '  if [ "$have" != "$want" ]; then',
    '    newer=$(node -e \'const [a,b]=process.argv.slice(1).map(v=>String(v).split(".").map(n=>parseInt(n,10)||0));for(let i=0;i<3;i++)if(a[i]!==b[i]){process.stdout.write(a[i]>b[i]?"yes":"no");process.exit(0)}process.stdout.write("no")\' "$have" "$want" 2>/dev/null)',
    '    if [ "$newer" = yes ]; then fix="pullboard init"; else fix="npm i $scope pullboard@$want"; fi',
    `    echo "pullboard ${hook}: stopped before running any rule; these hooks were installed by Pullboard $want, but $bin is Pullboard \${have:-unknown}. Run: $fix" >&2`,
    '    exit 1',
    '  fi',
    `  exec "$bin" hook ${hook}${args}`,
    '}',
    'for bin in "$root/node_modules/.bin/pullboard" "$main/node_modules/.bin/pullboard"; do',
    '  if [ -x "$bin" ]; then run "$bin" -D; fi',
    'done',
    'if command -v pullboard >/dev/null 2>&1; then run pullboard -g; fi',
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
 * @param {(path: string) => void} [onWrite] Observe only files this installer actually writes.
 * @returns {string[]} What happened, one line per hook.
 */
export function installHooks(root, onWrite = () => {}) {
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
    const script = hookScript(hook);
    if (existing === script) {
      if ((statSync(file).mode & 0o777) !== 0o755) {
        chmodSync(file, 0o755);
        onWrite(`${HOOKS_DIR}/${hook}`);
        notes.push(`restored executable mode for ${HOOKS_DIR}/${hook}`);
      } else notes.push(`kept ${HOOKS_DIR}/${hook}`);
      continue;
    }
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    onWrite(`${HOOKS_DIR}/${hook}`);
    notes.push(`wrote ${HOOKS_DIR}/${hook}`);
  }
  const current = gitConfig(root, 'core.hooksPath').stdout;
  if (current && current !== HOOKS_DIR) {
    notes.push(`core.hooksPath is ${current}; left as is. Call pullboard hook <name> from those hooks`);
  } else if (current === HOOKS_DIR) {
    notes.push(`kept core.hooksPath at ${HOOKS_DIR}`);
  } else {
    git(root, ['config', 'core.hooksPath', HOOKS_DIR]);
    notes.push(`set core.hooksPath to ${HOOKS_DIR}`);
  }
  return notes;
}

/**
 * The added lines of a staged change too large to read in one diff, read in batches of written paths halved until each
 * read fits the same buffer cap. Why: a one-step layout move stages more text than one safe read, yet every added line must still be
 * scanned for secrets; only a single file over the cap is refused [C7,V32].
 *
 * @param {string} root - Checkout root.
 * @param {string[]} written - Staged paths the commit writes.
 * @returns {ReturnType<typeof addedLines>}
 */
function addedLinesInBatches(root, written) {
  const added = [], pending = [written];
  while (pending.length) {
    const paths = pending.pop();
    if (!paths.length) continue;
    let diff;
    try {
      diff = git(root, ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', '--', ...paths], { maxBuffer: MAX_SECRET_DIFF_BYTES });
    } catch (error) {
      if (error.code !== 'ENOBUFS') throw error;
      if (paths.length === 1) throw new Refused('DIFF_TOO_LARGE', `${paths[0]} alone exceeds the safe scan limit; split that file into smaller commits, then retry`);
      // Halve an oversized batch until each read fits.
      pending.push(paths.slice(0, paths.length >> 1), paths.slice(paths.length >> 1));
      continue;
    }
    for (const row of addedLines(diff)) added.push(row); // no spread: a batch can hold more rows than the call stack
  }
  return added;
}
