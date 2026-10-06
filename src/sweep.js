/**
 * `pullboard sweep` (N15): turns a checker's report into work a small model can do. A linter, a
 * type checker or any tool that names a file and a line finds the problems; the sweep files one
 * item per file, in the lane that owns it, with the exact problems in its brief and the same tool,
 * run on that file, as its check. Much of a codebase's rigor is just running that loop.
 */
import { relative, isAbsolute } from 'node:path';

const TSC_RE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.+)$/;
const LINE_RE = /^([^\s:][^:]*?):(\d+)(?::(\d+))?:?\s+(.+)$/;
const SEVERITY_RE = /^(?:error|warning|note|info)\s*:?\s*/i;
const RULE_FIRST_RE = /^\[?([A-Z]{1,4}\d{2,5}|[a-z@][\w-]*\/[\w-]+|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)\]?:?\s+(.+)$/;
const RULE_LAST_RE = /^(.*?)\s+\[(?:(?:error|warning)\/)?([A-Za-z@][\w/-]*)\]$/i;
const MAX_LISTED = 30;

/**
 * Problems from ESLint's JSON report, or null when the text is not one.
 *
 * @param {string} text
 * @returns {{ file: string, line: number, col: number, rule: string, message: string }[] | null}
 */
function fromEslint(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let report;
  try {
    report = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(report) || !report.every((entry) => typeof entry?.filePath === 'string' && Array.isArray(entry.messages))) return null;
  return report.flatMap((entry) =>
    entry.messages.map((message) => ({
      file: entry.filePath,
      line: message.line ?? 0,
      col: message.column ?? 0,
      rule: message.ruleId ?? 'parse',
      message: String(message.message ?? '').trim(),
    })),
  );
}

/**
 * A problem's rule and message, in the shapes checkers print: a code or rule name first (`F401 ...`,
 * `no-var ...`), or a rule in brackets last (`... [return]`, `... [Error/no-var]`).
 *
 * @param {string} text
 * @returns {{ rule: string, message: string }}
 */
function ruleAndMessage(text) {
  const rest = text.replace(SEVERITY_RE, '').trim();
  const first = RULE_FIRST_RE.exec(rest);
  if (first) return { rule: first[1], message: first[2].trim() };
  const last = RULE_LAST_RE.exec(rest);
  if (last) return { rule: last[2], message: last[1].trim() };
  return { rule: '', message: rest };
}

/**
 * Problems from a report in lines: TypeScript's `file(line,col): error TS1234: message`, or the
 * `file:line:col: message` most other checkers print.
 *
 * @param {string} text
 * @returns {{ file: string, line: number, col: number, rule: string, message: string }[]}
 */
function fromLines(text) {
  return text.split('\n').flatMap((raw) => {
    const line = raw.trim();
    const tsc = TSC_RE.exec(line);
    if (tsc) return [{ file: tsc[1], line: Number(tsc[2]), col: Number(tsc[3]), rule: tsc[4], message: tsc[5] }];
    const plain = LINE_RE.exec(line);
    if (!plain || !/[./]/.test(plain[1])) return [];
    const [, file, row, col = '0', rest] = plain;
    return [{ file, line: Number(row), col: Number(col), ...ruleAndMessage(rest) }];
  });
}

/**
 * Every problem a checker reported, with paths relative to the repo.
 *
 * @param {string} text - The checker's output.
 * @param {string} root
 * @returns {{ file: string, line: number, col: number, rule: string, message: string }[]}
 */
export function parseProblems(text, root) {
  const problems = fromEslint(text) ?? fromLines(text);
  return problems.map((problem) => ({
    ...problem,
    file: isAbsolute(problem.file) ? relative(root, problem.file) : problem.file.replace(/^\.\//, ''),
  }));
}

/**
 * The items a sweep would file: one per file with problems, skipping files an open sweep item
 * already covers, at most `max`.
 *
 * @param {ReturnType<typeof parseProblems>} problems
 * @param {{ laneOf: (path: string) => string, covered: Set<string>, check: string, report: string, route: string, max: number }} options
 * @returns {{ items: any[], skipped: string[] }}
 */
export function sweepItems(problems, { laneOf, covered, check, report, route, max }) {
  const byFile = new Map();
  for (const problem of problems) {
    if (!problem.file || problem.file.startsWith('..')) continue;
    byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), problem]);
  }
  const items = [];
  const skipped = [];
  for (const [file, found] of [...byFile].sort((first, second) => second[1].length - first[1].length)) {
    if (covered.has(file)) {
      skipped.push(file);
      continue;
    }
    if (items.length >= max) break;
    const listed = found.slice(0, MAX_LISTED).map((problem) => `- line ${problem.line}${problem.col ? `:${problem.col}` : ''}${problem.rule ? ` ${problem.rule}` : ''}: ${problem.message}`);
    const more = found.length > MAX_LISTED ? [`- and ${found.length - MAX_LISTED} more like these`] : [];
    items.push({
      file,
      lane: laneOf(file),
      route,
      title: `fix ${found.length} ${found.length === 1 ? 'problem' : 'problems'} in ${file}`,
      criterion: `\`${report}\` reports no problems in ${file}, and its behavior is unchanged: the gate stays green`,
      check: check.replaceAll('{file}', file),
      brief: [
        'Files:',
        `- ${file}`,
        'Change:',
        `- fix each problem the checker reported in ${file}, changing as little as each fix needs:`,
        ...listed,
        ...more,
        'Test:',
        `- the check reports nothing for ${file}, and the existing tests still pass`,
        'Out of scope: every other file; disabling the rule; ignore or suppression comments; changing what the code does',
      ].join('\n'),
    });
  }
  return { items, skipped };
}
