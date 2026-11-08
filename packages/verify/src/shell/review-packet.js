/**
 * The review packet: one prepared page a reviewer reads instead of checking out and rerunning [V4,C7].
 *
 * It is built once, when an item's gate goes green (or red only in cases main fails by name), from what the gate already recorded: the
 * submit event's proof, the native proof receipts at that head, the known-main failures and the
 * check baseline. Git supplies the diff and the cells and lint baselines by reading objects only,
 * never by checking anything out. The packet is stored under the board's directory, keyed by item
 * and head, so `show --review` and `next --verify` print it without a checkout or a test process.
 */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { gitExecFileSync } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { testOutcomeFields } from '../../core.js';
import { frozenBar } from '../core/frozen-clause.js';
import { frozenRowGates } from '../core/frozen-clause.js';
import { wording } from '../core/frozen-clause.js';
import { criterionClauses } from '../../../state/index.js';

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
  return gitExecFileSync(['-C', root, ...args], { env, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? { encoding: 'utf8' } : { input }) });
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
  if (!Number.isSafeInteger(Number(id)) || !SHA.test(head ?? '')) return null;
  return join(commonDir, 'pullboard', 'review-packets', String(id), `${head}.json`);
}

/** The stored packet for this head, or null when none was built. */
function readReviewPacket(commonDir, id, head, criterionDigest) {
  try {
    const path = reviewPacketPath(commonDir, id, head);
    const packet = path && JSON.parse(readFileSync(path, 'utf8'));
    return packet?.version === VERSION && packet.item === Number(id) && packet.head === head
      && packet.criterionDigest === criterionDigest ? packet : null;
  } catch { return null; }
}

/** Write through a temporary file, so a reader never sees half a packet. */
function storeReviewPacket(commonDir, packet) {
  const path = reviewPacketPath(commonDir, packet.item, packet.head);
  if (!path) return null;
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
function reviewPacketInputs(board, { getItem, events, eventsOfKinds }, id) {
  const item = getItem(board, id);
  const history = events(board, { itemId: id });
  const detailOf = event => { try { return JSON.parse(event.event_detail); } catch { return {}; } };
  const submit = history.filter(event => event.event_kind === 'submit').map(detailOf).findLast(detail => detail.commit === item.item_commit) ?? null;
  const receipts = history.filter(event => event.event_kind === 'proof-run').map(event => detailOf(event).receipt)
    .filter(receipt => receipt && receipt.item === Number(id) && receipt.commit === item.item_commit);
  const baseline = history.filter(event => event.event_kind === 'check-baseline').map(event => detailOf(event).checkBaseline).at(-1) ?? null;
  // The main comparison runs recorded at the known main, read only for a gate red in main's named cases (#3449).
  const known = submit?.gateGreen === false ? submit.submissionProof?.knownMainFailures : null;
  const mainRuns = known && typeof eventsOfKinds === 'function' ? eventsOfKinds(board, ['gate-run']).map(event => detailOf(event).run)
    .filter(run => run?.kind === 'main-red' && run.head === known.main).map(run => run.id) : [];
  return { item, submit, receipts, baseline, mainRuns };
}

/**
 * The submit's known main failures when every red its gate recorded at head is one of them by file and name, else null.
 * Why: submit accepts a proof red only in cases main fails by name and records gateGreen false, but the packet was
 * stored only for a green gate, so every such item met NO_REVIEW_PACKET and sat in review for hours (#3449) [V4,C7].
 * A red receipt that names no failing case cannot be matched, so it leaves no packet.
 */
function excusedMainReds(submit, receipts) {
  const known = submit?.submissionProof?.knownMainFailures;
  if (submit?.gateGreen !== false || !SHA.test(known?.main ?? '') || !Array.isArray(known.failures) || !known.failures.length) return null;
  const red = receipts.filter(receipt => receipt.exitCode !== 0 && receipt.green !== true);
  if (red.some(receipt => !(receipt.failures ?? []).length)) return null;
  const named = (row, failure) => row.file === failure.file && row.name === failure.name;
  return red.flatMap(receipt => receipt.failures).every(failure => known.failures.some(row => named(row, failure))) ? known : null;
}

/** The id of the main comparison receipt at `main` that records this case failing, from the gate's own receipt files. */
function mainReceiptFor(commonDir, ids, main, failure) {
  for (const id of new Set(ids)) {
    if (!commonDir || !/^[a-f0-9-]{36}$/u.test(id ?? '')) continue;
    try {
      const stored = JSON.parse(readFileSync(join(commonDir, 'pullboard', 'gate-receipts', `${id}.json`), 'utf8'));
      if (stored.id === id && stored.kind === 'main-red' && stored.head === main
        && (stored.failures ?? []).some(row => row.file === failure.file && row.name === failure.name)) return id;
    } catch { /* A missing or unreadable receipt names nothing; the next candidate may. */ }
  }
  return null;
}

/** Split the frozen bar into numbered clauses: the criterion's sentences, then each frozen row. */
function packetClauses(item) {
  const bar = frozenBar(item);
  const criterion = bar.criterion || wording(item.item_criterion);
  const numbered = criterionClauses(item.item_criterion ?? criterion);
  const sentences = numbered.length ? numbered.map(clause => ({ n: clause.number, text: clause.text, ...(clause.kind ? { kind: clause.kind } : {}) }))
    : criterion.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'#])/u).map(text => text.trim()).filter(Boolean).map(text => ({ text }));
  const gates = new Map(frozenRowGates(item).map(row => [row.id, row.file]));
  return [...sentences, ...bar.rows.map(row => ({ id: row.id, text: `${row.id}: ${row.text}`, ...(gates.has(row.id) ? { gate: gates.get(row.id) } : {}) }))]
    .map((clause, index) => ({ n: index + 1, ...clause }));
}

/** Content words, lightly stemmed, for matching a clause against test names. */
function words(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length >= 4 && !STOP.has(word))
    .map(word => word.replace(/(?:es|s)$/u, '')));
}

/**
 * The per-test outcomes the gate observed for one receipt, read from the gate's own receipt file at this head.
 * Only executed tests count: a declared test the run skipped, or a run with no per-test record, maps to no run.
 */
function receiptOutcomes(commonDir, receipt, head, { declared = false } = {}) {
  if (!commonDir || !/^[a-f0-9-]{36}$/u.test(receipt.id ?? '')) return [];
  try {
    const stored = JSON.parse(readFileSync(join(commonDir, 'pullboard', 'gate-receipts', `${receipt.id}.json`), 'utf8'));
    if (stored.id !== receipt.id || stored.head !== head) return [];
    return (testOutcomeFields(stored.testOutcomes) ?? []).filter(row => declared || !row.skipped);
  } catch { return []; }
}

/** Whether a test file's source imports the module at `target` (a repo path) by a relative specifier. */
function importsModule(file, source, target) {
  if (!source) return false;
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/gu)) {
    if (posix.join(posix.dirname(file), match[2]) === target) return true;
  }
  return false;
}

/**
 * Attribute each outcome to a test file the receipt ran. Why: Node records a case at the file that called test(), so a
 * case a test file loads from a .fixture.js module carries the fixture's path, and the packet matched none of those
 * cases to a clause; #3222's 35 green cases mapped to nothing [V4,C7]. The owner is the ran file that imports the
 * module, else the only file the receipt ran; `source` keeps the defining file.
 */
function ownedOutcomes(rows, ranFiles, sources) {
  return rows.map(row => {
    if (ranFiles.includes(row.file)) return row;
    const owner = ranFiles.find(file => importsModule(file, sources.get(file), row.file)) ?? (ranFiles.length === 1 ? ranFiles[0] : null);
    return owner ? { ...row, file: owner, source: row.file } : row;
  });
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

/**
 * A clause's evidence from the test files it names: the named cases each receipt executed in that file, those citing
 * the clause when any do, else every executed case; a file-level row only for a receipt that recorded no case in it.
 * Why: #3253's clause named both check files, so its packet showed two file-level passes (test: null) and review
 * rejected INSUFFICIENT_EVIDENCE although the gate had run the clause 1 case green [C7,V4].
 *
 * @param {{n:number}} clause
 * @param {{receipt:string,file:string}[]} fileRuns - the receipts' file-level rows for files the clause names
 * @param {{receipt:string,file:string,test:string}[]} executed - every executed case the receipts recorded
 * @param {(name:string, n:number) => boolean} citesClause
 */
function namedFileEvidence(clause, fileRuns, executed, citesClause) {
  return fileRuns.flatMap(run => {
    const cases = executed.filter(row => row.receipt === run.receipt && row.file === run.file && row.test.replace(/^\.\//u, '') !== run.file);
    if (!cases.length) return [{ ...run, test: null, why: 'clause names the file' }];
    const own = cases.filter(row => citesClause(row.test, clause.n));
    return (own.length ? own : cases).map(row => ({ ...row, why: own.length ? 'test cites the clause' : 'case in the file the clause names' }));
  });
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
 * Build the packet for an item whose gate went green at its head, or went red only in cases main fails by name,
 * or null otherwise. Reads Git objects only (diff, ls-tree, cat-file), so it never checks anything out and never
 * starts a test. It returns rather than refuses because submit and verify reach it; only show names the refusal.
 * `mainReceiptIds` are the submit's main comparison receipts; the board's recorded main runs are tried too.
 */
function buildReviewPacket(root, { item, submit, receipts, baseline, mainRuns = [] }, { now = new Date(), commonDir = null, errors = [], mainReceiptIds = [] } = {}) {
  const id = Number(item.item_id);
  const head = item.item_commit;
  const excused = submit && submit.gateGreen !== true ? excusedMainReds(submit, receipts) : null;
  if (!submit || (submit.gateGreen !== true && !excused) || !SHA.test(head ?? '')) return null;
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
  const runOf = receipt => ({ receipt: receipt.id, kind: receipt.kind, phase: receipt.submitPhase ?? null, runner: receipt.runner ?? null });
  const runs = receipts.flatMap((receipt, index) => receiptFiles(receipt, index, { checkFiles, proofFiles }).map(file => ({
    ...runOf(receipt), file, result: fileResult(receipt, file),
  })));
  const ranFiles = [...new Set(runs.map(run => run.file))];
  // The submit gate's own proof runs, one row per receipt: a full-suite clause cites these, not one file.
  const suiteRuns = receipts.filter((receipt, index) => (receipt.submitPhase ? receipt.submitPhase !== 'criterion' : index > 0))
    .map(receipt => ({ receipt: receipt.id, kind: receipt.kind, phase: receipt.submitPhase ?? null, runner: receipt.runner ?? null,
      file: '(submit gate)', result: receipt.exitCode === 0 || receipt.green === true ? 'pass' : 'fail', test: null, why: 'full suite run by the submit gate' }));
  const clauses = packetClauses(item);
  // Tests are matched in files this item changed or its check names: those are the tests written for this bar.
  const candidates = ranFiles.filter(file => changed.includes(file) || checkFiles.includes(file) || clauses.some(clause => clause.text.includes(file) || clause.gate === file));
  // A case defined in a fixture module counts for the ran test file that loads it (#3441).
  const sources = new Map([...readBlobs(root, candidates.map(file => `${head}:${file}`))].map(([spec, text]) => [spec.slice(head.length + 1), text]));
  const outcomesOf = (receipt, index, options) => ownedOutcomes(receiptOutcomes(commonDir, receipt, head, options),
    receiptFiles(receipt, index, { checkFiles, proofFiles }), sources).filter(row => candidates.includes(row.file));
  // Each executed test the gate recorded, with its own result; a skipped or unrecorded test is never a run (#2451).
  const executed = receipts.flatMap((receipt, index) => outcomesOf(receipt, index)
    .map(row => ({ ...runOf(receipt), file: row.file, result: row.passed ? 'pass' : 'fail', test: row.name,
      ...(row.source ? { source: row.source } : {}) })));
  // Every declared case, skipped ones included: a clause with a case written for it is judged by that case alone.
  const declared = receipts.flatMap((receipt, index) => outcomesOf(receipt, index, { declared: true }).map(row => row.name));
  const citesClause = (name, n) => [...String(name ?? '').matchAll(/\bclause\s+(\d+)\b/giu)].some(match => Number(match[1]) === n);
  const mapped = clauses.map(clause => {
    const clauseWords = words(clause.text);
    let evidence = namedFileEvidence(clause, runs.filter(run => candidates.includes(run.file) && clause.text.includes(run.file)), executed, citesClause);
    // A frozen spec row is proved by the named, executed cases of the gate test its row names, which submit runs with
    // the proof [V4]. A file-level run proves nothing here: a skipped run has no executed cases, and a zero-case file
    // reports only a pseudo-case named for the file itself.
    if (clause.gate) evidence.push(...executed.filter(run => run.file === clause.gate && run.test.replace(/^\.\//u, '') !== clause.gate)
      .map(run => ({ ...run, why: "the row's gate test" })));
    for (const run of executed) {
      if (clause.text.includes(run.file) || run.file === clause.gate) continue;
      const cited = [...run.test.matchAll(/\bclause\s+(\d+)\b/giu)].some(match => Number(match[1]) === clause.n)
        || (clause.id && [...run.test.matchAll(/\[([^\]]+)\]/gu)].some(match => match[1].split(',').map(part => part.trim()).includes(clause.id)));
      const testWords = words(run.test);
      const shared = [...testWords].filter(word => clauseWords.has(word)).length;
      if (cited || (shared >= 3 && shared * 2 >= testWords.size)) evidence.push({ ...run, why: cited ? 'test cites the clause' : `${shared} shared words` });
    }
    // A test clause that names no file and no case still has the item's own check: the executed cases of the check's
    // files, run by the submit gate at this head, are its recorded run. Why: on 6 Nov 18 of 28 rejects in 90 minutes
    // were "no recorded run for clause N" on items whose gate had run exactly those files green [V4,C7].
    if (!evidence.length && clause.kind === 'test' && checkFiles.length && !declared.some(name => citesClause(name, clause.n))) {
      evidence = executed.filter(run => checkFiles.includes(run.file) && run.test.replace(/^\.\//u, '') !== run.file)
        .map(run => ({ ...run, why: "the item's check ran" }));
    }
    let gap = evidence.length ? null : 'no recorded run';
    if (!evidence.length && SUITE.test(clause.text)) {
      if (proof.deferred === true) gap = `no recorded run: the submit gate deferred the full suite${proof.reason ? ` (${proof.reason})` : ''}`;
      else if (proof.full === true) evidence = suiteRuns;
    }
    return { ...clause, runs: evidence, ...(evidence.length ? {} : { gap: gap ?? 'no recorded run' }) };
  });
  const seen = new Set();
  const atHead = receipts.flatMap(receipt => (receipt.failures ?? []).map(failure => ({ ...failure, receipt: receipt.id })))
    .filter(failure => !seen.has(`${failure.file}\0${failure.name}`) && seen.add(`${failure.file}\0${failure.name}`))
    .map(failure => ({ file: failure.file, name: failure.name, receipt: failure.receipt,
      error: errors.find(row => row?.name === failure.name && (!row.file || row.file === failure.file))?.error ?? null,
      ...mainStatus(failure, { known: proof.knownMainFailures, baseline }) }));
  // A gate red only in main's named cases keeps those cases apart from the item's own failures: they are listed with
  // the main receipt that names each, and never read as this item's red, so the reviewer judges its own clauses (#3449).
  const failures = excused ? [] : atHead;
  const mainIds = [...mainReceiptIds, ...mainRuns];
  const excusedMain = (excused ? atHead : []).map(failure => {
    const repair = excused.failures.find(row => row.file === failure.file && row.name === failure.name)?.item;
    return { ...failure, alsoRedOnMain: true, main: excused.main, mainReceipt: mainReceiptFor(commonDir, mainIds, excused.main, failure),
      ...(repair ? { repair } : {}) };
  });
  const cellsBefore = cellsAt(root, base);
  const cellsAfter = cellsAt(root, head);
  const touched = [...new Set(changed.map(file => /^(?:apps|packages)\/[^/]+/u.exec(file)?.[0]).filter(Boolean))].sort();
  return {
    version: VERSION, item: id, head, tree: item.item_tree ?? null, base, main, builtAt: now.toISOString(),
    criterionDigest: submit.criterionDigest ?? item.item_frozen_digest ?? null,
    proof: { full: proof.full === true, deferred: proof.deferred === true, files: proofFiles.length, reason: proof.reason ?? '' },
    diff: { stat, patch, truncated, files: changed },
    gate: excused ? 'red only in main reds' : 'green', clauses: mapped, failures, excusedMainReds: excusedMain,
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
  const lines = [`review packet #${packet.item} at ${short(packet.head)}: base ${short(packet.base)}, main ${short(packet.main)}; built ${packet.builtAt} when the gate went ${packet.gate === 'red only in main reds' ? 'red only in cases main also fails by name' : 'green'}`];
  lines.push(`proof: ${packet.proof.full ? 'full suite' : packet.proof.deferred ? 'full suite deferred to the landing gate' : 'selected files'}; ${packet.proof.files} proof file(s)`);
  lines.push('clauses:');
  for (const clause of packet.clauses) {
    lines.push(`  ${clause.n}. ${clause.text}`);
    if (!clause.runs.length) lines.push(`     ${clause.gap}: read this clause and name it in --read`);
    for (const run of clause.runs) {
      lines.push(`     ${run.result} ${run.file}${run.test ? ` "${run.test}"` : ''}; receipt ${run.receipt.slice(0, 8)} (${run.kind}${run.phase ? `, ${run.phase}` : ''}${run.runner ? `, ${run.runner}` : ''}); ${run.why}`);
    }
  }
  lines.push(packet.failures.length ? 'failures at head:' : 'failures at head: none');
  for (const failure of packet.failures) {
    lines.push(`  ${failure.file} :: ${failure.name}: ${failure.alsoRedOnMain ? `also red on main ${short(failure.main)}${failure.repair ? `, repair #${failure.repair}` : ''}` : `not red on main ${short(failure.main)}`}`,
      `     first error: ${failure.error ?? 'no error line recorded'}`);
  }
  // Main's own reds come after the item's clauses and failures, under their own heading, so none reads as the item's.
  const excused = packet.excusedMainReds ?? [];
  if (excused.length) lines.push(`excused main reds (not this item's: each fails on main by name, so they do not count against its clauses):`);
  for (const red of excused) {
    lines.push(`  ${red.file} :: ${red.name}: red on main ${short(red.main)}, main receipt ${red.mainReceipt ? red.mainReceipt.slice(0, 8) : 'not recorded'}${red.repair ? `, repair #${red.repair}` : ''}; head receipt ${String(red.receipt ?? 'unknown').slice(0, 8)}`);
  }
  const { cells } = packet;
  lines.push(`cells: ${cells.before} before, ${cells.after} after${cells.added.length ? `; added ${cells.added.join(', ')}` : ''}${cells.removed.length ? `; removed ${cells.removed.join(', ')}` : ''}; touched ${cells.touched.join(', ') || 'none'}`);
  const metrics = [...new Set([...Object.keys(packet.lints.before), ...Object.keys(packet.lints.after)])].sort();
  lines.push(`lints: ${metrics.map(metric => `${metric} ${packet.lints.before[metric] ?? 0} -> ${packet.lints.after[metric] ?? 0}`).join(', ') || 'no cell lint baselines'}`);
  const rerun = reviewRerunClauses(packet);
  lines.push(`review rule: read every clause marked no recorded run (${rerun.join(', ') || 'none'}) and name it in --read; accept with --read <clauses you read> records the verdict at once, and the frozen check reruns only for a clause you did not read`);
  lines.push('diff stat:', ...packet.diff.stat.split('\n').map(line => `  ${line}`));
  if (hunks) lines.push('diff:', packet.diff.patch.trimEnd(), ...(packet.diff.truncated ? ['(diff truncated at 4 MiB)'] : []));
  return lines;
}

/**
 * The stored packet for the item's head, built and stored first when its gate is green and none
 * exists yet (a packet from another machine's gate, or one built before this release).
 */
function loadReviewPacket(root, commonDir, inputs) {
  const stored = readReviewPacket(commonDir, inputs.item.item_id, inputs.item.item_commit, inputs.item.item_frozen_digest);
  if (stored) return stored;
  const packet = buildReviewPacket(root, inputs, { commonDir });
  if (packet) storeReviewPacket(commonDir, packet);
  return packet;
}

/**
 * Store the packet right after a submit whose gate went green, or red only in main's named cases; a failure never
 * fails the submit. `errors` are the gate summary's failed cases, so each failure at head carries its first error
 * line; `mainReceiptIds` are the main comparison receipts the submit ran, so each excused main red names its own.
 */
export async function recordReviewPacket(ctx, id, readBoard, { errors = [], mainReceiptIds = [] } = {}) {
  try {
    const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
    const packet = buildReviewPacket(ctx.info.root, inputs, { commonDir: ctx.info.commonDir, errors, mainReceiptIds });
    return packet && storeReviewPacket(ctx.info.commonDir, packet);
  } catch (error) {
    ctx.io.err(`review packet for #${id} was not stored (${error.message}); pullboard show ${id} --review builds it`);
    return null;
  }
}

/** Print the packet for `show <id> --review`; it reads the stored packet and runs no checkout or test. */
export async function showReviewPacket(ctx, id, readBoard, { json = false } = {}) {
  const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
  const packet = loadReviewPacket(ctx.info.root, ctx.info.commonDir, inputs);
  if (!packet) throw new Refused('NO_REVIEW_PACKET', `item #${id} has no green gate at ${String(inputs.item.item_commit ?? 'no head').slice(0, 12)}; its packet is stored when its queued gate goes green, so read pullboard show ${id} until then`);
  if (json) ctx.io.result?.(packet);
  else for (const line of renderReviewPacket(packet)) ctx.io.say(line);
  return 0;
}

/**
 * The packet lines `next --verify` prints with its offer; an item without a green gate at its
 * head gets one line saying so, because the offer itself must still print.
 */
export async function reviewPacketLines(ctx, id, readBoard) {
  const inputs = await readBoard((board, store) => reviewPacketInputs(board, store, id));
  const packet = loadReviewPacket(ctx.info.root, ctx.info.commonDir, inputs);
  // The offer prints the packet without its hunks: the CLI caps output near 8 KB, so a full diff was cut off and every
  // reviewer fetched it again with git. The summary fits; the diff is one named command away [V4,C7].
  return packet ? [...renderReviewPacket(packet, { hunks: false }), `diff: git diff ${packet.base.slice(0, 12)} ${packet.head.slice(0, 12)} (or pullboard show ${id} --review for the hunks)`]
    : [`review packet: none; the gate is not green at ${String(inputs.item.item_commit ?? 'no head').slice(0, 12)}, so review it the usual way`];
}

/**
 * The verdict line for an accept from the packet: which clauses the reviewer read, and which had
 * no recorded run. Only an accept records it; a reject names its clause with --clause.
 */
export function reviewPacketReadNote(commonDir, item, read, decision) {
  if (read === undefined) return '';
  if (decision !== 'ACCEPT') throw new Refused('USAGE', '--read records the packet clauses an accept read; a reject names its clause with --clause');
  const packet = readReviewPacket(commonDir, item.item_id, item.item_commit, item.item_frozen_digest);
  if (!packet) throw new Refused('USAGE', `no review packet for #${item.item_id} at ${item.item_commit.slice(0, 12)}; read pullboard show ${item.item_id} --review first`);
  const all = packet.clauses.map(clause => clause.n);
  const numbers = String(read).trim() === 'all' ? all : String(read).split(',').map(part => Number(part.trim()));
  if (!numbers.length || numbers.some(n => !all.includes(n))) {
    throw new Refused('USAGE', `--read takes clause numbers from 1 to ${all.length}, comma-separated, or all`);
  }
  const rerun = reviewRerunClauses(packet);
  return `\nreview packet ${packet.head.slice(0, 12)}: read clauses ${[...new Set(numbers)].sort((a, b) => a - b).join(', ')}; no recorded run: ${rerun.join(', ') || 'none'}`;
}

/**
 * What the stored packet at the item's head says an accept must rerun: null with no packet, otherwise
 * the clause numbers with no recorded run. An empty list lets accept record the verdict from the packet.
 *
 * Why: the packet is stored only after a green gate at that exact head, so a clause it covers was already
 * proved there; rerunning it in a fresh checkout repeats minutes of work and proves nothing new.
 * A failure recorded at head always forces the frozen check.
 */
export function reviewPacketRerun(commonDir, item) {
  const packet = readReviewPacket(commonDir, item.item_id, item.item_commit, item.item_frozen_digest);
  if (!packet) return null;
  // A reasoning clause has no run to record: the reviewer's reading is its evidence, so an accept that read it
  // need not rerun the frozen check for it. Why: #3089's clause 3 [reasoning] cost a 200 s rerun on 6 Nov [V4,C7].
  const reasoning = packet.clauses.filter(clause => !clause.runs.length && clause.kind === 'reasoning').map(clause => clause.n);
  return { head: packet.head, rerun: reviewRerunClauses(packet), reasoning, failures: packet.failures?.length ?? 0 };
}
