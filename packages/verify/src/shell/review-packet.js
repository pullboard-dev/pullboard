/**
 * The review packet: one prepared page a reviewer reads instead of checking out and rerunning [V4,C7].
 *
 * It is built once, when an item's gate goes green, from what the gate already recorded: the
 * submit event's proof, the native proof receipts at that head, the known-main failures and the
 * check baseline. Git supplies the diff and the cells and lint baselines by reading objects only,
 * never by checking anything out. The packet is stored under the board's directory, keyed by item
 * and head, so `show --review` and `next --verify` print it without a checkout or a test process.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { frozenBar } from '../core/frozen-clause.js';
import { wording } from '../core/frozen-clause.js';

const VERSION = 1;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const STOP = new Set(['that', 'this', 'with', 'from', 'when', 'each', 'every', 'which', 'what', 'into', 'than', 'then', 'them', 'they',
  'their', 'there', 'have', 'only', 'more', 'most', 'must', 'does', 'item', 'items', 'test', 'tests', 'runs', 'gets', 'over', 'under',
  'also', 'none', 'some', 'same', 'other', 'words', 'whose', 'without']);
const SUITE = /\b(?:full|whole) suite\b/iu;
const PATCH_LIMIT = 4 * 1024 * 1024;

/** Run git with repository overrides stripped, so a hook's environment never redirects the read. */
function gitRead(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', root, ...args], { env, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? { encoding: 'utf8' } : { input }) });
}

/**
 * Read many blobs with one `git cat-file --batch`, keyed by the requested `rev:path`.
 * One process instead of one per file keeps a packet build well under a second.
 */
function readBlobs(root, specs) {
  const blobs = new Map();
  if (!specs.length) return blobs;
  const out = gitRead(root, ['cat-file', '--batch'], specs.join('\n') + '\n');
  let at = 0;
  for (const spec of specs) {
    const end = out.indexOf(10, at);
    const header = out.subarray(at, end).toString('utf8');
    at = end + 1;
    const size = /^[a-f0-9]+ blob (\d+)$/u.exec(header);
    if (!size) continue;
    blobs.set(spec, out.subarray(at, at + Number(size[1])).toString('utf8'));
    at += Number(size[1]) + 1;
  }
  return blobs;
}

/** Where the board keeps the packet for one item head. */
function reviewPacketPath(commonDir, id, head) {
  if (!Number.isSafeInteger(Number(id)) || !SHA.test(head ?? '')) throw new Refused('NO_REVIEW_PACKET', `item #${id} has no submitted head to review; submit it first`);
  return join(commonDir, 'pullboard', 'review-packets', String(id), `${head}.json`);
}

/** The stored packet for this head, or null when none was built. */
function readReviewPacket(commonDir, id, head) {
  try {
    const packet = JSON.parse(readFileSync(reviewPacketPath(commonDir, id, head), 'utf8'));
    return packet?.version === VERSION && packet.item === Number(id) && packet.head === head ? packet : null;
  } catch { return null; }
}

/** Write through a temporary file, so a reader never sees half a packet. */
function storeReviewPacket(commonDir, packet) {
  const path = reviewPacketPath(commonDir, packet.item, packet.head);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(packet) + '\n');
  renameSync(temporary, path);
  return path;
}

/**
 * The board records a packet needs: the item, its newest submit at the head, the proof receipts
 * at that head and the check baseline. Board reads only; no Git and no process.
 */
function reviewPacketInputs(board, { getItem, events }, id) {
  const item = getItem(board, id);
  const history = events(board, { itemId: id });
  const detailOf = event => { try { return JSON.parse(event.event_detail); } catch { return {}; } };
  const submit = history.filter(event => event.event_kind === 'submit').map(detailOf).findLast(detail => detail.commit === item.item_commit) ?? null;
  const receipts = history.filter(event => event.event_kind === 'proof-run').map(event => detailOf(event).receipt)
    .filter(receipt => receipt && receipt.item === Number(id) && receipt.commit === item.item_commit);
  const baseline = history.filter(event => event.event_kind === 'check-baseline').map(event => detailOf(event).checkBaseline).at(-1) ?? null;
  return { item, submit, receipts, baseline };
}

/** Split the frozen bar into numbered clauses: the criterion's sentences, then each frozen row. */
function packetClauses(item) {
  const bar = frozenBar(item);
  const criterion = bar.criterion || wording(item.item_criterion);
  const sentences = criterion.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'#])/u).map(text => text.trim()).filter(Boolean);
  return [...sentences.map(text => ({ text })), ...bar.rows.map(row => ({ id: row.id, text: `${row.id}: ${row.text}` }))]
    .map((clause, index) => ({ n: index + 1, ...clause }));
}

/** Content words, lightly stemmed, for matching a clause against test names. */
function words(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length >= 4 && !STOP.has(word))
    .map(word => word.replace(/(?:es|s)$/u, '')));
}

/** The test names a file declares, read from its source at the head. */
function testNames(source) {
  return [...source.matchAll(/\b(?:test|it)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gu)].map(match => match[2]);
}

/** Test-like paths named in a shell command or clause, in order. */
function namedTestFiles(text) {
  return [...new Set([...String(text).matchAll(/[\w./-]+\.(?:test|spec)\.[cm]?js\b/gu)].map(match => match[0].replace(/^\.\//u, '')))];
}

/**
 * Which files each receipt ran: its self-reported children, else the frozen check's named files
 * for the criterion run and the submission proof's files for the proof runs.
 */
function receiptFiles(receipt, index, { checkFiles, proofFiles }) {
  const reported = (receipt.testRuntimes ?? []).map(row => row.file).filter(Boolean);
  if (reported.length) return [...new Set(reported)];
  const criterion = receipt.submitPhase ? receipt.submitPhase === 'criterion' : index === 0;
  return criterion ? checkFiles : proofFiles;
}

/** The result one receipt recorded for one file. */
function fileResult(receipt, file) {
  if ((receipt.failures ?? []).some(failure => failure.file === file)) return 'fail';
  if (receipt.exitCode === 0 || receipt.green === true) return 'pass';
  return receipt.exitCode == null ? 'unknown' : 'fail';
}

/** Whether a failure at head also fails on main, from the gate's recorded comparison or the check baseline. */
function mainStatus(failure, { known, baseline }) {
  const match = known?.failures?.find(row => row.file === failure.file && row.name === failure.name);
  if (match) return { alsoRedOnMain: true, main: known.main, ...(match.item ? { repair: match.item } : {}) };
  if (baseline?.result === 'red' && baseline.testEvidence?.failed?.includes(failure.name)) return { alsoRedOnMain: true, main: baseline.main };
  return { alsoRedOnMain: false, main: known?.main ?? baseline?.main ?? null };
}

/** Sum each committed cell-lint baseline's allowances by metric at one commit. */
function lintCounts(root, commit) {
  const listing = gitRead(root, ['ls-tree', '--name-only', commit, 'bin/cell-lint-baselines/']).split('\n').filter(path => path.endsWith('.json'));
  const blobs = readBlobs(root, listing.map(path => `${commit}:${path}`));
  const counts = {};
  for (const text of blobs.values()) {
    try {
      const baseline = JSON.parse(text);
      if (typeof baseline.metric !== 'string' || !baseline.allowances) continue;
      counts[baseline.metric] = (counts[baseline.metric] ?? 0) + Object.values(baseline.allowances).reduce((sum, count) => sum + (Number(count) || 0), 0);
    } catch { /* An unreadable baseline counts as nothing; the gate's ratchet judges it, not the packet. */ }
  }
  return counts;
}

/** The cells (apps/* and packages/* folders) present at one commit. */
function cellsAt(root, commit) {
  const files = gitRead(root, ['ls-tree', '-r', '--name-only', commit, '--', 'apps', 'packages']).split('\n').filter(Boolean);
  return new Set(files.map(file => /^(?:apps|packages)\/[^/]+/u.exec(file)?.[0]).filter(Boolean));
}

/**
 * Build the packet for an item whose gate went green at its head. Reads Git objects only (diff,
 * ls-tree, cat-file), so it never checks anything out and never starts a test.
 */
function buildReviewPacket(root, { item, submit, receipts, baseline }, { now = new Date() } = {}) {
  const id = Number(item.item_id);
  const head = item.item_commit;
  if (!submit || submit.gateGreen !== true) {
    throw new Refused('NO_REVIEW_PACKET', `item #${id}'s gate is not green at ${String(head ?? 'no head').slice(0, 12)}; the packet is built when its queued gate goes green`);
  }
  const main = SHA.test(submit.policyCommit ?? '') ? submit.policyCommit : null;
  const base = main ? gitRead(root, ['merge-base', main, head]).trim() : gitRead(root, ['rev-parse', `${head}^`]).trim();
  const stat = gitRead(root, ['diff', '--stat', '--no-color', base, head]).trimEnd();
  let patch = gitRead(root, ['diff', '--no-color', '--no-ext-diff', base, head]);
  const truncated = Buffer.byteLength(patch) > PATCH_LIMIT;
  if (truncated) patch = patch.slice(0, PATCH_LIMIT);
  const changed = gitRead(root, ['diff', '--name-only', '--no-renames', base, head]).split('\n').filter(Boolean);
  const proof = submit.submissionProof ?? {};
  const checkText = frozenBar(item).check || wording(item.item_check);
  const checkFiles = namedTestFiles(checkText);
  const proofFiles = Array.isArray(proof.files) ? proof.files : [];
  const runs = receipts.flatMap((receipt, index) => receiptFiles(receipt, index, { checkFiles, proofFiles }).map(file => ({
    receipt: receipt.id, kind: receipt.kind, phase: receipt.submitPhase ?? null, runner: receipt.runner ?? null, file, result: fileResult(receipt, file),
  })));
  const ranFiles = [...new Set(runs.map(run => run.file))];
  // The submit gate's own proof runs, one row per receipt: a full-suite clause cites these, not one file.
  const suiteRuns = receipts.filter((receipt, index) => (receipt.submitPhase ? receipt.submitPhase !== 'criterion' : index > 0))
    .map(receipt => ({ receipt: receipt.id, kind: receipt.kind, phase: receipt.submitPhase ?? null, runner: receipt.runner ?? null,
      file: '(submit gate)', result: receipt.exitCode === 0 || receipt.green === true ? 'pass' : 'fail', test: null, why: 'full suite run by the submit gate' }));
  const clauses = packetClauses(item);
  // Test names are read for files this item changed or its check names: those are the tests written for this bar.
  const candidates = ranFiles.filter(file => changed.includes(file) || checkFiles.includes(file) || clauses.some(clause => clause.text.includes(file)));
  const sources = readBlobs(root, candidates.map(file => `${head}:${file}`));
  const named = candidates.map(file => ({ file, names: testNames(sources.get(`${head}:${file}`) ?? '') }));
  const mapped = clauses.map(clause => {
    const clauseWords = words(clause.text);
    const covers = [];
    for (const { file, names } of named) {
      if (clause.text.includes(file)) { covers.push({ file, test: null, why: 'clause names the file' }); continue; }
      for (const name of names) {
        const cited = [...name.matchAll(/\bclause\s+(\d+)\b/giu)].some(match => Number(match[1]) === clause.n)
          || (clause.id && [...name.matchAll(/\[([^\]]+)\]/gu)].some(match => match[1].split(',').map(part => part.trim()).includes(clause.id)));
        const testWords = words(name);
        const shared = [...testWords].filter(word => clauseWords.has(word)).length;
        if (cited || (shared >= 3 && shared * 2 >= testWords.size)) covers.push({ file, test: name, why: cited ? 'test cites the clause' : `${shared} shared words` });
      }
    }
    let evidence = covers.flatMap(cover => runs.filter(run => run.file === cover.file).map(run => ({ ...run, test: cover.test, why: cover.why })));
    let gap = evidence.length ? null : 'no recorded run';
    if (!evidence.length && SUITE.test(clause.text)) {
      if (proof.deferred === true) gap = `no recorded run: the submit gate deferred the full suite${proof.reason ? ` (${proof.reason})` : ''}`;
      else if (proof.full === true) evidence = suiteRuns;
    }
    return { ...clause, runs: evidence, ...(evidence.length ? {} : { gap: gap ?? 'no recorded run' }) };
  });
  const seen = new Set();
  const failures = receipts.flatMap(receipt => (receipt.failures ?? []).map(failure => ({ ...failure, receipt: receipt.id })))
    .filter(failure => !seen.has(`${failure.file}\0${failure.name}`) && seen.add(`${failure.file}\0${failure.name}`))
    .map(failure => ({ file: failure.file, name: failure.name, receipt: failure.receipt, ...mainStatus(failure, { known: proof.knownMainFailures, baseline }) }));
  const cellsBefore = cellsAt(root, base);
  const cellsAfter = cellsAt(root, head);
  const touched = [...new Set(changed.map(file => /^(?:apps|packages)\/[^/]+/u.exec(file)?.[0]).filter(Boolean))].sort();
  return {
    version: VERSION, item: id, head, tree: item.item_tree ?? null, base, main, builtAt: now.toISOString(),
    criterionDigest: submit.criterionDigest ?? item.item_frozen_digest ?? null,
    proof: { full: proof.full === true, deferred: proof.deferred === true, files: proofFiles.length, reason: proof.reason ?? '' },
    diff: { stat, patch, truncated, files: changed },
    clauses: mapped, failures,
    cells: { before: cellsBefore.size, after: cellsAfter.size, added: [...cellsAfter].filter(cell => !cellsBefore.has(cell)).sort(),
      removed: [...cellsBefore].filter(cell => !cellsAfter.has(cell)).sort(), touched },
    lints: { before: lintCounts(root, base), after: lintCounts(root, head) },
  };
}

/** The clauses a reviewer must rerun: only those with no recorded run. */
function reviewRerunClauses(packet) {
  return packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n);
}

/** The packet as lines, summary first and the full hunks last. */
function renderReviewPacket(packet, { hunks = true } = {}) {
  const short = sha => (sha ? sha.slice(0, 12) : 'unknown');
  const lines = [`review packet #${packet.item} at ${short(packet.head)}: base ${short(packet.base)}, main ${short(packet.main)}; built ${packet.builtAt} when the gate went green`];
  lines.push(`proof: ${packet.proof.full ? 'full suite' : packet.proof.deferred ? 'full suite deferred to the landing gate' : 'selected files'}; ${packet.proof.files} proof file(s)`);
  lines.push('clauses:');
  for (const clause of packet.clauses) {
    lines.push(`  ${clause.n}. ${clause.text}`);
    if (!clause.runs.length) lines.push(`     ${clause.gap}: rerun this clause`);
    for (const run of clause.runs) {
      lines.push(`     ${run.result} ${run.file}${run.test ? ` "${run.test}"` : ''}; receipt ${run.receipt.slice(0, 8)} (${run.kind}${run.phase ? `, ${run.phase}` : ''}${run.runner ? `, ${run.runner}` : ''}); ${run.why}`);
    }
  }
  lines.push(packet.failures.length ? 'failures at head:' : 'failures at head: none');
  for (const failure of packet.failures) {
    lines.push(`  ${failure.file} :: ${failure.name}: ${failure.alsoRedOnMain ? `also red on main ${short(failure.main)}${failure.repair ? `, repair #${failure.repair}` : ''}` : `not red on main ${short(failure.main)}`}`);
  }
  const { cells } = packet;
  lines.push(`cells: ${cells.before} before, ${cells.after} after${cells.added.length ? `; added ${cells.added.join(', ')}` : ''}${cells.removed.length ? `; removed ${cells.removed.join(', ')}` : ''}; touched ${cells.touched.join(', ') || 'none'}`);
  const metrics = [...new Set([...Object.keys(packet.lints.before), ...Object.keys(packet.lints.after)])].sort();
  lines.push(`lints: ${metrics.map(metric => `${metric} ${packet.lints.before[metric] ?? 0} -> ${packet.lints.after[metric] ?? 0}`).join(', ') || 'no cell lint baselines'}`);
  const rerun = reviewRerunClauses(packet);
  lines.push(`review rule: rerun only clauses marked no recorded run (${rerun.join(', ') || 'none'}); accept with --read <clauses you read>`);
  lines.push('diff stat:', ...packet.diff.stat.split('\n').map(line => `  ${line}`));
  if (hunks) lines.push('diff:', packet.diff.patch.trimEnd(), ...(packet.diff.truncated ? ['(diff truncated at 4 MiB)'] : []));
  return lines;
}

/**
 * The stored packet for the item's head, built and stored first when its gate is green and none
 * exists yet (a packet from another machine's gate, or one built before this release).
 */
function loadReviewPacket(root, commonDir, inputs) {
  const stored = readReviewPacket(commonDir, inputs.item.item_id, inputs.item.item_commit);
  if (stored) return stored;
  const packet = buildReviewPacket(root, inputs);
  storeReviewPacket(commonDir, packet);
  return packet;
}

/** Store the packet right after a submit whose gate went green; a failure never fails the submit. */
export async function recordReviewPacket(ctx, id, readBoard) {
  try {
    const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
    if (inputs.submit?.gateGreen !== true) return null;
    return storeReviewPacket(ctx.info.commonDir, buildReviewPacket(ctx.info.root, inputs));
  } catch (error) {
    ctx.io.err(`review packet for #${id} was not stored (${error.message}); pullboard show ${id} --review builds it`);
    return null;
  }
}

/** Print the packet for `show <id> --review`; it reads the stored packet and runs no checkout or test. */
export async function showReviewPacket(ctx, id, readBoard, { json = false } = {}) {
  const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
  if (!inputs.item.item_commit) throw new Refused('NO_REVIEW_PACKET', `item #${id} has no submitted head; its packet is built when its gate goes green`);
  const packet = loadReviewPacket(ctx.info.root, ctx.info.commonDir, inputs);
  if (json) ctx.io.result?.(packet);
  else for (const line of renderReviewPacket(packet)) ctx.io.say(line);
  return 0;
}

/**
 * The packet lines `next --verify` prints with its offer; an item without a green gate at its
 * head gets one line saying so, because the offer itself must still print.
 */
export async function reviewPacketLines(ctx, id, readBoard) {
  try {
    const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
    return renderReviewPacket(loadReviewPacket(ctx.info.root, ctx.info.commonDir, inputs));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return [`review packet: none (${error.message})`];
  }
}

/**
 * The verdict line for an accept from the packet: which clauses the reviewer read, and which had
 * no recorded run. Only an accept records it; a reject names its clause with --clause.
 */
export function reviewPacketReadNote(commonDir, item, read, decision) {
  if (read === undefined) return '';
  if (decision !== 'ACCEPT') throw new Refused('USAGE', '--read records the packet clauses an accept read; a reject names its clause with --clause');
  const packet = readReviewPacket(commonDir, item.item_id, item.item_commit);
  if (!packet) throw new Refused('NO_REVIEW_PACKET', `no review packet for #${item.item_id} at ${item.item_commit.slice(0, 12)}; read pullboard show ${item.item_id} --review first`);
  const all = packet.clauses.map(clause => clause.n);
  const numbers = String(read).trim() === 'all' ? all : String(read).split(',').map(part => Number(part.trim()));
  if (!numbers.length || numbers.some(n => !all.includes(n))) {
    throw new Refused('USAGE', `--read takes clause numbers from 1 to ${all.length}, comma-separated, or all`);
  }
  const rerun = reviewRerunClauses(packet);
  return `\nreview packet ${packet.head.slice(0, 12)}: read clauses ${[...new Set(numbers)].sort((a, b) => a - b).join(', ')}; no recorded run: ${rerun.join(', ') || 'none'}`;
}
