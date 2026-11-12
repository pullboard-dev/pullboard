/**
 * Every failure a contribution record can return maps to a rule, a fix line and the skill command that fixes it [CR5].
 *
 * Why: the gate comment names the rule, the fix and the command for each failure (RFC 0009), so the table is data
 * and a test fails when a refusal code in the parser or the clause runner has no row here.
 */

/** The skill command that re-reads a record after the fix. */
export const CONTRIBUTION_CHECK_COMMAND = 'pullboard contribute check <file>';

/** One row per refusal code: the rule broken, the fix, and the skill command. */
export const CONTRIBUTION_FIXES = Object.freeze({
  CONTRIB_INPUT: Object.freeze({ rule: 'the machine part must be text', fix: 'pass the YAML block of the record as text', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_SIZE: Object.freeze({ rule: 'a record is at most 16 KB', fix: 'cut the record to 16 KB; keep constraints in fields and shorten the prose', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_HIDDEN: Object.freeze({ rule: 'no bidirectional, zero-width, invisible or null characters anywhere', fix: 'delete the invisible characters and retype the line', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_SHAPE: Object.freeze({ rule: 'a record has one of the seven shapes', fix: 'use Bug, Ask, Flaky, Performance, Fix, Proposal or Security', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_MULTIDOC: Object.freeze({ rule: 'one YAML document, no --- or ... lines', fix: 'send one YAML block with no document markers', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_TAB: Object.freeze({ rule: 'indent with spaces, never tabs', fix: 'indent with two spaces', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_INDENT: Object.freeze({ rule: 'an indented line belongs under a key, in two-space steps', fix: 'start each field at the left edge and indent children by two spaces', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_LINE: Object.freeze({ rule: 'a line is key: value or key: with indented items', fix: 'write one field per line as key: value', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_KEY: Object.freeze({ rule: 'keys come from the closed field list for the shape', fix: 'delete the key, or move its content into a listed field or the summary', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_DUPLICATE: Object.freeze({ rule: 'a key appears once', fix: 'keep one copy of the key', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_REQUIRED: Object.freeze({ rule: 'each shape carries its required fields, and every bar clause its check', fix: 'add the missing field or check line', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_EMPTY: Object.freeze({ rule: 'a field has a value', fix: 'write a value after the key or delete the field', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_NESTED: Object.freeze({ rule: 'a scalar field holds one value', fix: 'put the value on the key line, or quote it', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_LIST: Object.freeze({ rule: 'a list field is a key then two-space - item lines', fix: "write the key, then one '  - item' line per entry", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_BLOCK: Object.freeze({ rule: 'block text is only for refusal and error, marked with |', fix: "put the text on one line, or write 'key: |' and indent the lines", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_QUOTE: Object.freeze({ rule: 'a quoted value is one closed string', fix: 'close the quote on the same line and escape inner quotes', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ANCHOR: Object.freeze({ rule: 'YAML anchors are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ALIAS: Object.freeze({ rule: 'YAML aliases are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_TAG: Object.freeze({ rule: 'YAML tags are not allowed', fix: 'remove the tag and write a plain or quoted string', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_FLOW: Object.freeze({ rule: 'inline lists and maps are not allowed', fix: "write a list as '  - item' lines under the key", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_MERGE: Object.freeze({ rule: 'merge keys are not allowed', fix: 'write the value out in full', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_VALUE: Object.freeze({ rule: 'a field with a closed vocabulary or fixed form takes only that', fix: 'use a listed value, such as want: guidance or rate: 3/20', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_ID: Object.freeze({ rule: 'row and issue ids are plain ASCII', fix: 'use ids such as G1.2 for rows and 42 for issues', command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_CLAUSE: Object.freeze({ rule: 'each bar clause starts with its number', fix: "write each clause as '1: what must hold [kind]'", command: CONTRIBUTION_CHECK_COMMAND }),
  CONTRIB_CLAUSES: Object.freeze({ rule: 'a record has at most 50 bar clauses', fix: 'merge or drop clauses until there are at most 50', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NUMBER: Object.freeze({ rule: 'each bar clause starts with its number', fix: "write each clause as '1: what must hold [kind]'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_KIND: Object.freeze({ rule: 'a clause ends with its kind, or its check is none with a reason', fix: 'end the clause with [test], [test, kept], [command] or [measurement]', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NONE_REASON: Object.freeze({ rule: 'a check of none says why', fix: "write 'none: <why the gate cannot run it here>'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_PATH: Object.freeze({ rule: 'a path names a file inside the repository', fix: 'use a relative path with no .. segment, and no symlink out of the repository', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_TEST_CHECK: Object.freeze({ rule: "a test check is '<test file> > <test name>'", fix: "write the check as '<test file in repo> > <test name>'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_COMMAND_EMPTY: Object.freeze({ rule: 'a command check is not empty', fix: 'write the command the gate should run', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_COMMAND_SYNTAX: Object.freeze({ rule: 'a check command is plain words with no shell syntax', fix: 'remove the shell syntax and use plain words and repository paths', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NOT_ALLOWLISTED: Object.freeze({ rule: "a check command is on the repository's allowlist", fix: 'use a command the repository allowlists', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_THRESHOLD: Object.freeze({ rule: 'a measurement clause states its threshold', fix: "state it in the clause, such as 'under 100 ms' or 'at most 3'", command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_GIT: Object.freeze({ rule: 'the clause runner needs a repository holding base and head', fix: 'pass a repository that holds both commits', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_NODE_PIN: Object.freeze({ rule: 'the clause runner uses its pinned Node', fix: 'run the gate with the pinned Node version', command: CONTRIBUTION_CHECK_COMMAND }),
  CLAUSE_SCRATCH: Object.freeze({ rule: 'the scratch folder is an empty absolute path outside the repository', fix: 'pass an empty absolute folder outside the repository', command: CONTRIBUTION_CHECK_COMMAND }),
});

/**
 * The rule, fix line and skill command for a refusal code, or null when the code has no row.
 *
 * @param {string} code - A CONTRIB_ or CLAUSE_ refusal code.
 * @returns {{ rule: string, fix: string, command: string } | null}
 */
export function contributionFix(code) {
  return Object.hasOwn(CONTRIBUTION_FIXES, code) ? CONTRIBUTION_FIXES[code] : null;
}
