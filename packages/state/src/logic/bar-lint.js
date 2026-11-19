/** Code catches the plain faults in a bar when it is added or edited: too long, untagged, unmeasured, vague [C7,V2]. */
import { criterionClauses } from './clauses.js';
import { EVIDENCE_KINDS } from './clauses.js';

/** Most clauses one criterion may carry; a longer bar is two items. */
export const MAX_BAR_CLAUSES = 3;
/** Words that name no observable result, with the plain outcome to say instead. */
const VAGUE = [['works', /\bworks?\b/iu], ['properly', /\bproperly\b/iu], ['handles', /\bhandl(?:es|ed|ing|e)\b/iu],
  ['fast', /\bfast(?:er)?\b/iu], ['supports', /\bsupport(?:s|ed|ing)?\b/iu]];
const TAGGED = new RegExp(`\\s*\\[(${EVIDENCE_KINDS.join('|')})\\]\\s*[.;]?\\s*$`, 'u');
/** A test file path or base name, as a clause quotes it. */
const TEST_FILE = /[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/u;
/** The word that opens a second fact after "and": an auxiliary, or a third-person verb, as in "returns the id and writes the file". */
const FACT_OPENER = /^(?:is|are|was|were|has|have|had|does|do|can|will|must|should|exits?|\w{3,}[^s\W]s|\w+(?:ies|ses|xes))$/iu;
const PROVING = ['test', 'command', 'measurement'];

/**
 * Whether an "and" in the clause body joins two facts. An "and" that joins two nouns inside one fact, such as
 * "public method and documented behavior", is not a second fact; one followed by a verb is [C7,#11841].
 */
function joinsTwoFacts(body) {
  for (const match of body.matchAll(/\band\s+(\S+)/giu)) if (FACT_OPENER.test(match[1].replace(/[^\w]+$/u, ''))) return true;
  return false;
}

/** The bare words of a clause, without its closing evidence tag. */
function words(text) {
  return String(text).replace(TAGGED, '').trim();
}

/**
 * Read a criterion for faults the code can settle. Refusals stop the add or edit; warnings only speak.
 * A numbered bar is judged clause by clause; free text with no numbers is one clause and only ever warns,
 * so bars written before this rule keep working until someone edits them.
 *
 * @param {string} criterion
 * @param {{ allowLong?: boolean, warnUnnamedTest?: boolean, brief?: string }} [options] - allowLong: the author already gave a reason for a longer bar;
 *   warnUnnamedTest (add.warnUnnamedTest, default off): a [test] clause naming no test file, with no `Test:` line in the brief, gets BAR_TEST_UNNAMED
 * @returns {{ problems: string[], fix: string[], warnings: { code: string, clause: number, message: string }[] }}
 */
export function lintBar(criterion, { allowLong = false, warnUnnamedTest = false, brief = '' } = {}) {
  const text = String(criterion ?? '').trim();
  const problems = [];
  const fix = [];
  const warnings = [];
  if (!text) return { problems, fix, warnings };
  const numbered = criterionClauses(text, { single: true });
  const clauses = numbered.length ? numbered : [{ number: 1, text, kind: TAGGED.exec(text)?.[1] ?? null, free: true }];
  if (!allowLong && clauses.length > MAX_BAR_CLAUSES) {
    problems.push(`the criterion has ${clauses.length} clauses and a bar holds at most ${MAX_BAR_CLAUSES}`);
    fix.push(`split it into items of at most ${MAX_BAR_CLAUSES} clauses each`);
  }
  const briefNamesTest = /(?:^|\n)Test:/u.test(String(brief ?? ''));
  for (const clause of clauses) {
    const label = clauses.length > 1 || !clause.free ? `clause ${clause.number}` : 'the criterion';
    const body = words(clause.text);
    if (!clause.kind) {
      if (clause.free) warnings.push({ code: 'BAR_NO_EVIDENCE_TAG', clause: clause.number, message: `${label} has no [test], [command] or [measurement] tag; end it with the one that proves it` });
      // A numbered clause with no tag is refused by requireCriterionEvidence (CLAUSE_EVIDENCE_REQUIRED), which names the fix.
    } else if (clause.kind === 'measurement' && !/\d/u.test(body)) {
      problems.push(`${label} is a [measurement] with no number`);
      fix.push(`put the number in ${label}, such as "under 200 ms" or "at least 40 percent", or tag it [test] or [command]`);
    }
    // A gate run ticks a [test] clause only through a test file it names or the brief's Test: line [C7].
    if (warnUnnamedTest && clause.kind === 'test' && !briefNamesTest && !TEST_FILE.test(clause.text)) {
      warnings.push({ code: 'BAR_TEST_UNNAMED', clause: clause.number, message: `${label} is a [test] that names no test file and the brief has no Test: line, so no gate run can tick it; next: name the test file in ${label} or end the brief with "Test: <path>"` });
    }
    if (joinsTwoFacts(body)) warnings.push({ code: 'BAR_TWO_FACTS', clause: clause.number, message: `${label} joins two facts with "and"; give each fact its own clause so each can pass or fail alone` });
    for (const [word, pattern] of VAGUE) {
      if (pattern.test(body)) warnings.push({ code: 'BAR_VAGUE_WORD', clause: clause.number, message: `${label} says "${word}", which no reviewer can check; name the output, exit code or number that shows it` });
    }
  }
  return { problems, fix, warnings };
}
