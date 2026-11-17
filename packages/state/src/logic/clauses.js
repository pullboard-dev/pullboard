/** Clause inspection: a numbered criterion is ticked clause by clause, each with its evidence, before submit (#2050). */
import { Refused } from '../../../kernel/light.js';

export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'screenshot', 'measurement', 'reasoning']);
const KINDS = EVIDENCE_KINDS.join('|');
const CLAUSE_MARKER = /(?:^|\s)(\d+)[.)]\s+/gu;
const DECLARED = new RegExp(`\\[(${KINDS})\\]\\s*[.;]?\\s*$`, 'u');
const RUN_EVIDENCE = /^green pullboard (?:test|check) run of \S/u;
const TICK = new RegExp(`^clause (\\d+) \\[(${KINDS})\\]:\\s*(\\S[\\s\\S]*)$`, 'u');

/** The clauses of a criterion, or [] when it is free text: sequential numbered outcomes. */
export function criterionClauses(criterion, { single = false } = {}) {
  const source = String(criterion ?? '');
  const markers = [...source.matchAll(CLAUSE_MARKER)];
  if (!markers.length || (markers.length > 1 && markers.some((match, index) => Number(match[1]) !== index + 1))) return [];
  const firstStart = markerStart(markers[0]);
  if (!single && markers.length === 1 && source.slice(0, firstStart).trim()
    && !source.slice(0, firstStart).trim().endsWith(':')) return [];
  const clauses = markers.map((marker, index) => {
    const start = markerStart(marker);
    const header = /^\d+[.)]\s+/u.exec(source.slice(start));
    const contentStart = start + header[0].length;
    const end = index + 1 < markers.length ? markerStart(markers[index + 1]) : source.length;
    const text = source.slice(contentStart, end).trim().replace(/[;,]\s*$/u, '').trim();
    return { number: Number(marker[1]), text, kind: DECLARED.exec(text)?.[1] ?? null };
  });
  return clauses.every(clause => clause.text) ? clauses : [];
}

/** Locate the digit in a marker whether it begins a line or follows an inline separator. */
function markerStart(marker) {
  return marker.index + marker[0].lastIndexOf(marker[1]);
}

/**
 * The gate-run test file a [test] clause names, or null: a file in `gateFiles` that the clause text or the item's "Test:" brief quotes by
 * path or base name. Why: builders may not run tests, so the gate's own run is the evidence and the clause is ticked by it [C7].
 */
export function gateNamedFile(clause, gateFiles, item = null) {
  if (clause.kind !== 'test') return null;
  const declared = /(?:^|\n)Test:([\s\S]*)$/u.exec(item?.item_brief ?? '')?.[1] ?? '';
  const text = `${clause.text}\n${declared}`.toLowerCase();
  return [...gateFiles].find(file => file && (text.includes(file.toLowerCase()) || text.includes(file.split('/').pop().toLowerCase()))) ?? null;
}

/** A test file path or base name a clause's text quotes, such as `web/page.test.js`. */
const QUOTED_TEST = /[\w./-]+\.(?:test|spec)\.[cm]?js\b/u;

/**
 * The gate-run test files that tick a [test] clause: the file it names, or, when its text names no test file, the item
 * check's own files, which every gate runs; with `folderTicks` on, a folder the clause quotes covers the gate-run tests under it
 * first. [] when none applies. Why: most bars say "X passes on a runner [test]" and
 * keep the file in the check line, so submit refused CLAUSE_UNTICKED and builders ran the check before the gate ran it
 * again (#6675) [C7]. With `titleTicks` on, a clause nothing else covers is covered by the gate-run test files among
 * `cases` (rows with `file` and `name`, such as gate outcomes) holding a case titled "clause N:" for its number (#8879).
 */
export function gateCoveredFiles(clause, gateFiles, item = null, { folderTicks = false, titleTicks = false, cases = [] } = {}) {
  const named = gateNamedFile(clause, gateFiles, item);
  if (named) return [named];
  if (clause.kind !== 'test' || QUOTED_TEST.test(clause.text)) return [];
  const inFolder = folderTicks ? folderFiles(clause.text, gateFiles) : [];
  if (inFolder.length) return inFolder;
  const checked = checkTestFiles(item?.item_check);
  return checked.length || !titleTicks ? checked : titledFiles(clause.number, gateFiles, cases);
}

/**
 * The case titles a test file's source declares, as rows for gateCoveredFiles' `cases`. Why: before the gate runs, submit has
 * no outcomes, so it reads the titles the changed tests hold to decide which clauses the gate will tick (#8880) [C7].
 *
 * @param {string} file - The test file path.
 * @param {string} source - Its text.
 * @returns {{ file: string, name: string }[]}
 */
export function testCaseTitles(file, source) {
  return [...String(source ?? '').matchAll(/\b(?:test|it|describe)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gu)].map(match => ({ file, name: match[2] }));
}

/** True when a test case's title cites a clause as "clause N:", the fleet's naming rule for clause cases. */
function titledFor(number, name) {
  return new RegExp(`(?:^|[\\s>:(])clause\\s+${number}\\s*:`, 'iu').test(String(name ?? ''));
}

/**
 * The gate-run test files holding a case titled "clause N:" for a clause number, sorted. Why: most unticked clauses say
 * "A test shows ..." or "The same test proves ..." and name no file, while builders already title each case for its clause (#8879) [C7].
 */
function titledFiles(number, gateFiles, cases) {
  const files = new Set(gateFiles);
  return [...new Set((cases ?? []).filter(row => row && files.has(row.file) && titledFor(number, row.name)).map(row => row.file))].sort();
}

/** A path with at least two segments whose last segment has no file extension, such as `apps/cli/journeys/bar`. */
const QUOTED_FOLDER = /(?:^|[\s(`'"])((?:[\w-][\w.-]*\/)+[\w-]+)\/?(?=[\s,;:)`'"]|\.(?!\w)|$)/gu;

/**
 * The gate-run test files under a folder a clause quotes, sorted. Why: bars say "a new test in <folder> proves ..." because
 * a bar may only name paths on main, so the gate ticked none of them and every builder hand-ticked after its own run (#8846) [C7].
 */
function folderFiles(text, gateFiles) {
  const folders = [...String(text).matchAll(QUOTED_FOLDER)].map(match => `${match[1]}/`);
  return [...gateFiles].filter(file => file && TEST_FILE.test(file) && folders.some(folder => file.startsWith(folder))).sort();
}

/**
 * The latest tick each clause carries, read from ordinary note facts under the bar now in force. The holder's ticks count; an
 * earlier holder's count only when they cite `head`, the commit being submitted. A tick recorded before the criterion was edited
 * to other text never counts. A hand-written note never replaces a recorded green run. Why: a re-claim of the same bar at the
 * same head re-proved every clause on a runner (#5775, 11 Nov), and #3793 (11 Nov) wrote its own notes after pullboard test
 * ticked both clauses, the notes hid the run, and submit sent the seat to a second 254 s runner trip for the same file [C7].
 *
 * @param {object[]} thread - The item's thread, oldest first.
 * @param {string} owner - The current holder.
 * @param {{ criterion?: string, head?: string | null }} [current] - The bar text and head now in force.
 * @returns {Map<number, { kind: string, evidence: string }>}
 */
export function clauseTicks(thread, owner, { criterion, head = null } = {}) {
  const ticks = new Map();
  const heads = submittedHeads(thread, head);
  const edited = thread.some(entry => entry.type === 'move' && typeof entry.detail?.criterion === 'string');
  let bar = edited ? undefined : criterion;
  for (const entry of thread) {
    if (entry.type === 'move' && typeof entry.detail?.criterion === 'string') bar = entry.detail.criterion;
    if (entry.type !== 'fact' || entry.kind !== 'note') continue;
    const match = TICK.exec(String(entry.text).trim());
    if (!match || (criterion !== undefined && bar !== criterion)) continue;
    if (entry.by !== owner && !citesHead(match[3], heads)) continue;
    const tick = { kind: match[2], evidence: match[3].trim() };
    const held = ticks.get(Number(match[1]));
    if (held && RUN_EVIDENCE.test(held.evidence) && !RUN_EVIDENCE.test(tick.evidence)) continue;
    ticks.set(Number(match[1]), tick);
  }
  return ticks;
}

const SHELL_SYNTAX = /[;&|<>`$()!\\\n'"*?]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/**
 * The test files a frozen check runs when it is one plain command naming them, such as `node <runner> a.test.js`; [] for
 * anything a test run cannot stand in for: shell syntax, a negation, or no test file at all.
 */
function checkTestFiles(check) {
  const text = String(check ?? '').trim();
  if (!text || SHELL_SYNTAX.test(text)) return [];
  return text.split(/\s+/u).filter(word => TEST_FILE.test(word)).map(word => word.replace(/^\.\//u, ''));
}

/**
 * The submitted head and the builder source an automatic main merge recorded for it. Why: submit merges main into an unchanged
 * item head, and the earlier ticks cite that source, not the merge commit.
 */
function submittedHeads(thread, head) {
  const full = String(head ?? '').toLowerCase();
  if (!/^[0-9a-f]{7,64}$/u.test(full)) return [];
  const sources = thread.flatMap(entry => {
    const merge = entry.type === 'fact' && /automatic main merge: source ([0-9a-f]{7,64}), main [0-9a-f]+, merge ([0-9a-f]{7,64})\./u.exec(String(entry.text));
    return merge && (full.startsWith(merge[2]) || merge[2].startsWith(full)) ? [merge[1]] : [];
  });
  return [full, ...sources];
}

/** Whether evidence names one of `heads` by a hex prefix of at least 7 characters. */
function citesHead(evidence, heads) {
  const cited = String(evidence).toLowerCase().match(/\b[0-9a-f]{7,64}\b/gu) ?? [];
  return cited.some(sha => heads.some(full => full.startsWith(sha) || sha.startsWith(full)));
}

/**
 * A refusal naming every clause that is unticked or ticked with evidence of the wrong kind; null when all are met.
 * A test tick names a case that cites its clause, or a test file among `greenFiles`: the files a green proof of this
 * exact commit ran. Why: the gate already proved that file; refusing the submit until the builder retypes the case
 * name with "clause N" cost two or three submits per item on 6 Nov (588 tick notes in a morning) [C7].
 */
export function clauseInspectionProblem(item, thread, { greenFiles = new Set(), gateFiles = new Set(), head = null, folderTicks = false, titleTicks = false, cases = [] } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner, { criterion: item.item_criterion, head });
  const problems = [];
  const testClauses = [];
  const needed = [];
  for (const clause of clauses) {
    const tick = ticks.get(clause.number);
    const label = `clause ${clause.number} (${clause.text.slice(0, 80)})`;
    const proven = () => RUN_EVIDENCE.test(tick.evidence) || [...greenFiles].some(file => file && tick.evidence.includes(file));
    if (!tick && gateCoveredFiles(clause, new Set([...gateFiles, ...greenFiles]), item, { folderTicks, titleTicks, cases }).length) continue;
    const before = problems.length;
    if (!tick) { problems.push(`${label} has no evidence`); if (clause.kind === null || clause.kind === 'test') testClauses.push(clause); }
    else if (clause.kind && clause.kind !== tick.kind) {
      problems.push(`${label} needs ${clause.kind} evidence, not ${tick.kind}${tick.kind === 'reasoning' ? ' (the weakest kind)' : ''}`);
    } else if (tick.kind === 'test' && !new RegExp(`\\bclause\\s+${clause.number}\\b`, 'iu').test(tick.evidence) && !proven()) {
      problems.push(`${label} needs a named test case citing clause ${clause.number}, or a test file this commit's green proof ran`);
      testClauses.push(clause);
    }
    if (problems.length > before) needed.push(clause);
  }
  if (!problems.length) return null;
  const tickWith = `tick each with: ${needed.map(clause => tickCommand(item.item_id, clause)).join('; ')}; then submit again`;
  if (!testClauses.length) return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; ${tickWith}`);
  return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; ${testStep(item, testClauses).message} or ${tickWith}`, testStep(item, testClauses).next);
}

/**
 * The filled-in command that ticks one clause: its number, its declared kind (test when undeclared) and a line of evidence
 * of that kind to replace. Why: builders found the "clause N:" rule by trial and error, five retries in an hour on 5 Nov;
 * recording exactly these notes meets every clause they name [C7].
 */
function tickCommand(id, clause) {
  const kind = clause.kind ?? 'test';
  const evidence = {
    test: `the case titled 'clause ${clause.number}: <what it proves>', green in run <run id>`,
    measurement: '<the measured value and unit> from run <run id>',
    command: '<the command and its output> run on <commit>',
    screenshot: '<the screenshot path and what it shows>',
    reasoning: '<why the clause holds, citing the code>',
  }[kind];
  return `pullboard fact ${id} note "clause ${clause.number} [${kind}]: ${evidence}"`;
}

/**
 * The one command that ticks an unticked test clause: pullboard check <id> when the item has a frozen check, since it runs
 * the check and writes every test tick itself; otherwise pullboard test on a file a clause names.
 * Why: two light-route seats released #3544 and #3567 on 8 Nov after green test runs, because the old step said to hand-write a case name [C7].
 *
 * @param {object} item - The item row.
 * @param {{ text: string }[]} testClauses - The unticked test clauses.
 * @returns {{ message: string, next: string }}
 */
function testStep(item, testClauses) {
  const checkFiles = checkTestFiles(item.item_check);
  if (checkFiles.length) {
    // The one runner trip: the run ticks the clauses and its green is the receipt the gate's item check reuses [C7].
    const command = `pullboard test ${checkFiles.join(' ')}`;
    return { message: `run ${command}, the item's check files, which ticks every test clause when green`, next: `${command}, then submit again` };
  }
  if (String(item.item_check ?? '').trim()) {
    const command = `pullboard check ${item.item_id}`;
    return { message: `run ${command}, which runs the frozen check and ticks every test clause`, next: `${command}, then submit again` };
  }
  // A path the clause quotes that names a test; no runner's file naming is spelled out in this core file.
  const file = testClauses.flatMap(clause => clause.text.match(/[\w./-]+\/[\w.-]+\.[cm]?[jt]s/gu) ?? []).find(path => /test/u.test(path)) ?? null;
  const command = file ? `pullboard test ${file}` : 'pullboard test <a test file the clause names>';
  return { message: `run ${command}, then tick the clause with its green run`, next: `${command}, then tick the clause and submit again` };
}

/**
 * The tick notes a green `pullboard test` run earns: one per clause that is a test clause (declared [test] or
 * undeclared) when the run covered every test file the item's check names. Why: the run is the proof the clause cites,
 * so the builder never retypes a case name or spends a second run after a green runner proof; a run of only some of
 * the check's files proves only some of it, so it ticks nothing [C7].
 */
export function testRunTickNotes(item, files, head) {
  const clauses = criterionClauses(item.item_criterion);
  const ran = new Set(files.map(file => String(file).replace(/^\.\//u, '')));
  const needed = checkTestFiles(item.item_check);
  if (!clauses.length || !needed.length || !needed.every(file => ran.has(file))) return [];
  return testClauseTickNotes(clauses, `test run of ${files.join(' ')}`, head);
}

/**
 * The tick notes a green `pullboard check` run earns: the frozen check is the proof of every test clause, whether it is a test file
 * or a shell command such as `test ! -e src/x.js`. Why: shell-command checks never name a file `pullboard test` could run [C7].
 */
export function checkRunTickNotes(item, head) {
  const check = String(item.item_check ?? '').trim();
  return check ? testClauseTickNotes(criterionClauses(item.item_criterion), `check run of ${check}`, head) : [];
}

/** One tick note per test clause (declared [test] or undeclared) citing a green run description at a head commit. */
function testClauseTickNotes(clauses, run, head) {
  return clauses.filter(clause => clause.kind === null || clause.kind === 'test')
    .map(clause => `clause ${clause.number} [test]: green pullboard ${run} at ${head}`);
}

/** The most case names one gate tick note lists; the receipt keeps the rest. */
const NAMED_CASES = 5;

/**
 * One tick note per [test] clause the builder has not ticked whose named test file the gate ran green, naming the cases
 * the receipt observed passing in it. Why: submit no longer waits on a builder-run proof, so the gate records the
 * evidence itself, wherever the gate ran, and a red gate records none [C7,V4].
 *
 * @param {object} item - The submitted item.
 * @param {object[]} thread - The item's thread, to leave builder ticks alone.
 * @param {{ gateFiles: Set<string>, outcomes: { file: string, name: string, passed: boolean, skipped: boolean }[], head: string, folderTicks?: boolean, titleTicks?: boolean }} run - Files the gate ran, the receipts' per-test outcomes, the head proved and the tick options.
 * @returns {string[]} Note texts for the item's thread.
 */
export function gateClauseTickNotes(item, thread, { gateFiles, outcomes, head, folderTicks = false, titleTicks = false }) {
  const ticks = clauseTicks(thread, item.item_owner, { criterion: item.item_criterion, head });
  const notes = [];
  for (const clause of criterionClauses(item.item_criterion)) {
    if (ticks.has(clause.number)) continue;
    const files = gateCoveredFiles(clause, gateFiles, item, { folderTicks, titleTicks, cases: outcomes });
    if (!files.length) continue;
    const ran = row => files.includes(row.file) && !row.skipped;
    const passed = outcomes.filter(row => ran(row) && row.passed).map(row => row.name);
    if (files.some(file => !outcomes.some(row => ran(row) && row.file === file && row.passed)) || outcomes.some(row => ran(row) && !row.passed)) continue;
    // A clause case the gate skipped proved nothing, so a title-covered clause waits for every "clause N:" case to pass (#8879) [C7].
    if (titleTicks && outcomes.some(row => files.includes(row.file) && titledFor(clause.number, row.name) && (row.skipped || !row.passed))) continue;
    const file = files.join(' ');
    const listed = passed.slice(0, NAMED_CASES).join('; ');
    notes.push(`clause ${clause.number} [test]: gate run of ${file} green at ${head.slice(0, 12)}: ${passed.length} case${passed.length === 1 ? '' : 's'} passed (${listed}${passed.length > NAMED_CASES ? '; ...' : ''})`);
  }
  return notes;
}

/** One reviewer-facing line per clause with its evidence; reasoning is flagged as the weakest kind. */
export function clauseInspectionSummary(item, thread, { gateFiles = new Set(), head = null, folderTicks = false, titleTicks = false, cases = [] } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner, { criterion: item.item_criterion, head });
  return `inspection, clause by clause: ${clauses.map(clause => {
    const named = ticks.has(clause.number) ? [] : gateCoveredFiles(clause, gateFiles, item, { folderTicks, titleTicks, cases });
    const tick = named.length ? { kind: 'test', evidence: `ticked by the gate run of ${named.join(' ')}` } : ticks.get(clause.number);
    return `${clause.number}. ${clause.text.slice(0, 80)} -> ${tick.kind}${tick.kind === 'reasoning' ? ' (weakest evidence)' : ''}: ${tick.evidence}`;
  }).join(' | ')}`;
}

const LINK = /\bhttps?:\/\/[^\s"'`)]+/iu;
const FILE_PATH = /(?:^|[\s("'`])(?:[\w.@-]+\/)+[\w.@-]*\w(?::\d+)?(?=$|[\s)"'`,;:.])|(?:^|[\s("'`])[\w-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?::\d+)?(?=$|[\s)"'`,;:])/u;
const NOT_A_FILE = /^(?:e\.g|i\.e|vs|etc)$/iu;
const QUOTED = /"[^"\n]{3,}"|“[^”\n]{3,}”|`[^`\n]{3,}`/u;

/**
 * Whether one tick's evidence names something a reviewer can open: a file path, a link or a quoted passage.
 * Why: a checklist with no test check is proved only by review evidence, so the board decides mechanically which
 * lines name any, and the verifier spends judgment on what they show, never on whether they exist [C7].
 *
 * @param {string} evidence - The text after `clause <n> [kind]:` in the builder's tick.
 * @returns {boolean}
 */
export function namesEvidence(evidence) {
  const text = String(evidence ?? '');
  if (LINK.test(text) || QUOTED.test(text)) return true;
  const withoutLinks = text.replace(/\bhttps?:\/\/\S+/giu, ' ');
  const found = [...withoutLinks.matchAll(new RegExp(FILE_PATH.source, 'gu'))];
  return found.some(match => !NOT_A_FILE.test(match[0].trim().replace(/^["'`(]/u, '').replace(/[.,;:)"'`]+$/u, '')));
}

/**
 * The review checklist of an item that has no test check: its numbered clauses, each with the builder's tick.
 * Empty when the item has a check (the check proves it, and a checklist never stands in for it) or no numbered clauses.
 *
 * @param {object} item - The item row.
 * @param {object[]} thread - The item's thread.
 * @returns {{ number: number, text: string, kind: string|null, tick: { kind: string, evidence: string }|null }[]}
 */
export function reviewChecklist(item, thread) {
  if (String(item.item_check ?? '').trim()) return [];
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return [];
  const ticks = clauseTicks(thread, item.item_built_by ?? item.item_owner);
  return clauses.map(clause => ({ ...clause, tick: ticks.get(clause.number) ?? null }));
}

/**
 * A refusal naming every checklist line that names no file, link or quoted passage; null when each line does,
 * or when the item has a test check or no checklist. Why: without a check nothing ran, so an accept resting on a line
 * with no evidence would be a bare say-so [C7].
 */
export function checklistEvidenceProblem(item, thread) {
  const problems = checklistGaps(item, thread);
  if (!problems.length) return null;
  return new Refused('CLAUSE_UNTICKED', `#${item.item_id} has no test check, so its review checklist is its only proof, and ${problems.join('; ')}`,
    `reject it for the missing evidence: pullboard verify ${item.item_id} reject --reason TEST_FAILURE --clause "<frozen wording>" --note "<the line that names no file, link or quoted passage>"`);
}

/** One sentence per checklist line that has no tick or whose tick names no file, link or quoted passage. */
export function checklistGaps(item, thread) {
  return reviewChecklist(item, thread).filter(line => !line.tick || !namesEvidence(line.tick.evidence))
    .map(line => `clause ${line.number} (${line.text.slice(0, 80)}) ${line.tick ? `names no file, link or quoted passage: ${line.tick.evidence.slice(0, 80)}` : 'has no evidence'}`);
}

/** The receipt line of an accept that checklist evidence proved, or null when no checklist applied. */
export function checklistReceipt(item, thread) {
  const lines = reviewChecklist(item, thread);
  if (!lines.length || checklistEvidenceProblem(item, thread)) return null;
  return `review evidence proved it: ${lines.map(line => `${line.number}. ${line.text.slice(0, 60)} -> ${line.tick.kind}: ${line.tick.evidence}`).join(' | ')}`;
}
