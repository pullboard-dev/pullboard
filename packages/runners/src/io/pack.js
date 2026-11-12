/** Select safe ancestors and tags, then pack only the history objects a runner cache lacks [C7]. */
import { configFromSource } from '../../../config/index.js';
import { defaults } from '../../../config/index.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { secretsIn } from '../../../commits/index.js';
import { Refused } from '../../../kernel/index.js';
import { MAX_BLOB_BYTES } from './source/scan.js';
import { objectRecord } from './source/scan.js';
import { cachedScan } from './source/scan.js';
import { protectedHistoryPath } from './source/scan.js';
import { scannerTree } from './source/scan.js';
import { sourceGit } from './source/scan.js';
import { spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MAX_HISTORY_TAGS = 1_024;

const MAX_TAG_CHAIN = 8;

/** Select a locally known published ancestor, never an anonymous origin's unchecked latest tip. */
export function originAncestor(root, source) {
  const tip = sourceGit(root, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin']).split('\n')
    .find(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value));
  if (!tip) return undefined;
  const result = spawnSync('git', ['--no-replace-objects', 'merge-base', source.commit, tip], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096,
  });
  const base = result.stdout?.trim();
  return result.status === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base) ? base : undefined;
}

/**
 * Select safe tags that point to commits in the exact candidate ancestry. The selection for one commit and one exact
 * set of tag refs in one repository is kept (cachedScan): every object it reads is immutable.
 */
export function candidateTags(root, source) {
  const listed = sourceGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', 'refs/tags']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commit ?? '')) return selectTags(root, source, listed);
  const common = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return cachedScan('candidate-tags', [common, source.commit, listed], () => selectTags(root, source, listed));
}

/** Check every listed tag ref and keep those that peel to a commit in the candidate's ancestry. */
function selectTags(root, source, listed) {
  const rows = listed.split('\n').filter(Boolean);
  if (rows.length > MAX_HISTORY_TAGS) throw new Refused('RUNNER_SCAN_LIMIT', 'too many local tags to transfer safely; keep this run local');
  const selected = [];
  // Budget: annotation scanning shares the 8 MiB object ceiling across all selected tag visits.
  let annotationBytes = 0;
  for (const row of rows) {
    const fields = row.split('\0');
    if (fields.length !== 3) throw new Refused('RUNNER_SOURCE', 'cannot read local tag refs safely; keep this run local');
    const [name, object, declaredType] = fields;
    if (!name.startsWith('refs/tags/') || name.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(name)
      || !/^[a-f0-9]{40,64}$/u.test(object) || object.length !== source.commit.length) {
      throw new Refused('RUNNER_SECRET', 'a local tag ref failed the safe transfer check; keep this run local');
    }
    sourceGit(root, ['check-ref-format', name]);
    let type = sourceGit(root, ['cat-file', '-t', object]).trim();
    if (type !== declaredType) throw new Refused('RUNNER_SOURCE', 'a local tag ref changed while preparing the run; retry');
    const peeledCommit = sourceGit(root, ['rev-parse', `${name}^{}`]).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(peeledCommit) || peeledCommit.length !== source.commit.length
      || sourceGit(root, ['cat-file', '-t', peeledCommit]).trim() !== 'commit') continue;
    const ancestor = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', 'merge-base', '--is-ancestor', peeledCommit, source.commit], {
      cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096,
    });
    if (ancestor.status === 1) continue;
    if (ancestor.status !== 0) throw new Refused('RUNNER_SOURCE', 'cannot validate tag ancestry; keep this run local');
    if (secretsIn([{ path: 'tag ref', line: 1, text: name }]).length) {
      throw new Refused('RUNNER_SECRET', 'a selected tag ref failed the safe transfer check; keep this run local');
    }
    const chain = [];
    if (type === 'tag') {
      let current = object;
      const seen = new Set();
      while (type === 'tag') {
        if (chain.length >= MAX_TAG_CHAIN || seen.has(current)) {
          throw new Refused('RUNNER_SCAN_LIMIT', 'an annotated tag chain exceeds the safe transfer limit; keep this run local');
        }
        seen.add(current);
        const tagBody = sourceGit(root, ['cat-file', '-p', current]);
        annotationBytes += Buffer.byteLength(tagBody);
        if (annotationBytes > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a tag annotation exceeds the safe transfer limit; keep this run local');
        if (secretsIn(tagBody.split(/\r?\n/u).map((text, line) => ({ path: name, line: line + 1, text }))).length) {
          throw new Refused('RUNNER_SECRET', 'an annotated tag failed the source privacy scan; keep this run local');
        }
        const header = tagBody.split(/\r?\n\r?\n/u, 1)[0];
        const target = /^object ([a-f0-9]{40,64})$/mu.exec(header)?.[1];
        const targetType = /^type (commit|tag|tree|blob)$/mu.exec(header)?.[1];
        if (!target || target.length !== source.commit.length || !targetType
          || sourceGit(root, ['cat-file', '-t', target]).trim() !== targetType) {
          throw new Refused('RUNNER_SOURCE', 'an annotated tag has an invalid object chain; keep this run local');
        }
        chain.push(current);
        current = target;
        type = targetType;
      }
      if (type !== 'commit' || current !== peeledCommit) throw new Refused('RUNNER_SOURCE', 'an annotated tag did not peel to its declared commit');
    } else if (type !== 'commit' || object !== peeledCommit) continue;
    selected.push({ name, object, peeledCommit, chain });
  }
  return selected;
}

/**
 * Run a source read whose output grows with history into a private file in the pack directory and return its text.
 * Why: sourceGit buffers at most 8 MiB, and once main's unpublished object list passed that every runner dispatch and
 * merged record refused RUNNER_SOURCE (#3930); each line is still validated by its caller.
 */
function streamedSourceGit(root, args, directory, name, input) {
  const file = join(directory, name);
  const output = openSync(file, 'wx', 0o600);
  try { sourceGit(root, args, { input, stdio: ['pipe', output, 'pipe'] }); }
  finally { closeSync(output); }
  try { return readFileSync(file, 'utf8'); } finally { rmSync(file, { force: true }); }
}

/** How many fully scanned commits the pack verdict cache keeps per scanner and policy set. */
const CLEAN_PACK_KEEP = 16;

/**
 * The file of commits whose whole object history passed this exact scanner and protection policy, or null when no verdict
 * may be kept: a run outside a tooling export names no scanner rules, and a shallow or grafted clone's history is cut short.
 * Why: a runner with a cold cache reports no tips, so every pulled job rescanned all history (3 GB) in a serve-need process
 * that lived for minutes; a commit id names its whole history, so the verdict holds in every clone that has the commit (#5544).
 */
function cleanPackFile(root, protect) {
  const tree = scannerTree();
  if (!tree) return null;
  const common = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  if (existsSync(join(common, 'shallow')) || existsSync(join(common, 'info', 'grafts'))) return null;
  const home = process.env.PULLBOARD_MACHINE_HOME || join(process.env.HOME || homedir(), '.pullboard');
  return join(home, 'pack-scan', `${createHash('sha256').update(JSON.stringify([tree, protect])).digest('hex').slice(0, 32)}.json`);
}

/** The saved clean commits, newest first; a missing or unreadable file is empty. */
function cleanPackCommits(file) {
  if (!file) return [];
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value.filter(commit => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) : [];
  } catch { return []; }
}

/** Save the clean commits whole or not at all; an unwritable cache only costs the next scan its shortcut. */
function saveCleanPackCommits(file, commits) {
  const temporary = `${file}.${process.pid}.partial`;
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(commits), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* Nothing to keep. */ } finally { rmSync(temporary, { force: true }); }
}

/** Scan and pack exactly the candidate objects absent from the locked remote cache inventory. */
export function historyPack(root, source, tips, directory, tags = [], knownTagObjects = []) {
  const knownTags = new Set(knownTagObjects);
  const known = sourceGit(root, ['cat-file', '--batch-check'], { input: tips.map(tip => `${tip}\n`).join('') })
    .split('\n').map(line => /^([a-f0-9]{40,64}) commit \d+$/u.exec(line)?.[1]).filter(Boolean);
  const roots = [source.commit, ...(source.extraCommits ?? [])];
  const listed = (excluded, name) => streamedSourceGit(root, ['rev-list', '--objects', ...roots, '--not', ...excluded], directory, name)
    .split('\n').filter(Boolean).map(line => {
      const match = /^([a-f0-9]{40,64})(?: (.*))?$/u.exec(line);
      if (!match) throw new Refused('RUNNER_SOURCE', 'unsupported history path; keep this run local');
      return { object: match[1], path: match[2] ?? '' };
    });
  const config = source.protect ? { protect: source.protect } : sourceGit(root, ['ls-tree', '--name-only', source.commit, '--', 'pullboard.json']).trim()
    ? configFromSource(sourceGit(root, ['show', `${source.commit}:pullboard.json`])) : defaults();
  const cleanFile = cleanPackFile(root, config.protect);
  const saved = cleanPackCommits(cleanFile);
  // A saved commit counts only while this clone still has it.
  const clean = saved.length ? sourceGit(root, ['cat-file', '--batch-check'], { input: saved.map(commit => `${commit}\n`).join('') })
    .split('\n').map(line => /^([a-f0-9]{40,64}) commit \d+$/u.exec(line)?.[1]).filter(Boolean) : [];
  // Everything the runner lacks is packed; only what no earlier clean scan covered is read again.
  const records = listed(known, 'history.objects');
  const scanRecords = clean.length ? listed([...known, ...clean], 'history.scan-objects') : records;
  const objects = [...new Set([...records.map(record => record.object), ...tags.flatMap(tag => tag.chain).filter(object => !knownTags.has(object))])];
  const scanned = [...new Set([...scanRecords.map(record => record.object), ...tags.flatMap(tag => tag.chain).filter(object => !knownTags.has(object))])];
  const names = new Map(scanRecords.map(record => [record.object, record.path]));
  for (const tag of tags) for (const object of tag.chain) names.set(object, tag.name);
  const historicalTrees = new Set();
  const metadata = streamedSourceGit(root, ['cat-file', '--batch-check'], directory, 'history.metadata', scanned.map(object => `${object}\n`).join(''));
  for (const line of metadata.split('\n').filter(Boolean)) {
    const match = /^[a-f0-9]{40,64} (blob|tree|commit|tag) (\d+)$/u.exec(line);
    if (!match || Number(match[2]) > MAX_BLOB_BYTES) throw new Refused('RUNNER_SCAN_LIMIT', 'a historical object exceeds the safe runner scan limit; keep this run local');
  }
  if (scanned.length) {
    const scanFile = join(directory, 'history.scan');
    const output = openSync(scanFile, 'wx', 0o600);
    try { sourceGit(root, ['cat-file', '--batch'], { input: `${scanned.join('\n')}\n`, stdio: ['pipe', output, 'pipe'] }); }
    finally { closeSync(output); }
    const input = openSync(scanFile, 'r');
    try {
      for (let index = 0; index < scanned.length; index++) {
        const { object, type, data } = objectRecord(input);
        const path = names.get(object) || `history/${object}`;
        if (type === 'commit') {
          const tree = /^tree ([a-f0-9]{40,64})$/mu.exec(data.toString('utf8'))?.[1];
          if (!tree) throw new Refused('RUNNER_SOURCE', 'invalid historical commit; keep this run local');
          historicalTrees.add(tree);
        }
        if (type === 'tree') {
          let cursor = 0;
          while (cursor < data.length) {
            const space = data.indexOf(32, cursor), nul = data.indexOf(0, space + 1);
            if (space < cursor || nul < 0) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
            const mode = data.subarray(cursor, space).toString('ascii');
            const name = data.subarray(space + 1, nul).toString('utf8');
            const full = names.get(object) ? `${names.get(object)}/${name}` : name;
            if (mode === '160000' || protectedHistoryPath(full, config.protect)
              || secretsIn([{path:'historical tree',line:1,text:name}]).length) throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
            cursor = nul + 1 + source.commit.length / 2;
          }
          if (cursor !== data.length) throw new Refused('RUNNER_SOURCE', 'invalid historical tree; keep this run local');
        } else if (protectedHistoryPath(path, config.protect)
          || secretsIn(data.toString('utf8').split(/\r?\n/u).map((text, line) => ({ path, line: line + 1, text }))).length) {
          throw new Refused('RUNNER_SECRET', 'historical source failed its transfer scan; remove the private history or keep this run local');
        }
      }
    } finally { closeSync(input); rmSync(scanFile, { force: true }); }
  }
  // Check every full historical path, including reused cached blobs moved beneath a newly blocked prefix.
  for (const tree of historicalTrees) {
    for (const record of streamedSourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree], directory, 'history.tree').split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) [a-f0-9]{40,64}\t([\s\S]+)$/u.exec(record);
      if (!match || match[2] !== 'blob' || protectedHistoryPath(match[3], config.protect)) {
        throw new Refused('RUNNER_SECRET', 'historical source includes a blocked private path or submodule; keep this run local');
      }
    }
  }
  const pack = join(directory, 'source.pack');
  const output = openSync(pack, 'wx', 0o600);
  try { sourceGit(root, ['pack-objects', '--stdout'], { input: objects.map(object => `${object}\n`).join(''), stdio: ['pipe', output, 'pipe'] }); }
  finally { closeSync(output); }
  // Every object the runner lacked was read now or by a clean scan; the verdict is kept only when no runner-claimed tip hid history from it.
  if (cleanFile && (!known.length || !sourceGit(root, ['rev-list', '--max-count=1', ...known, '--not', ...clean]).trim())) {
    saveCleanPackCommits(cleanFile, [...new Set([...roots, ...saved])].slice(0, CLEAN_PACK_KEEP));
  }
  return pack;
}

/** Use only a credential-free anonymous HTTPS origin; SSH authentication is never forwarded. */
export function anonymousOrigin(root) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 4096 });
  if (result.status !== 0) return undefined;
  let address = result.stdout.trim();
  const ssh = /^git@([A-Za-z0-9][A-Za-z0-9.-]*):([^\s?#]+)$/u.exec(address);
  if (ssh) address = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || address.length > 2048) return undefined;
    if (secretsIn([{path:'anonymous origin',line:1,text:address}]).length) return undefined;
    return url.href;
  } catch { return undefined; }
}
