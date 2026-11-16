/**
 * Seeded faults for a mutation check: each fault changes one operator or literal on one line, so a test that exercises
 * that line should fail. Pure and deterministic; the same source and lines always give the same faults [C7].
 */

/** The operator swaps, tried in order on each line; every match is one fault. */
const OPERATORS = [
  { name: 'equality', pattern: /===|!==/g, swap: (text) => (text === '===' ? '!==' : '===') },
  { name: 'comparison', pattern: /(?<![<>=!-])(?:<=|>=|<|>)(?![<>=])/g, swap: (text) => ({ '<=': '>', '>=': '<', '<': '>=', '>': '<=' })[text] },
  { name: 'logic', pattern: /&&|\|\|/g, swap: (text) => (text === '&&' ? '||' : '&&') },
  { name: 'boolean', pattern: /\b(?:true|false)\b/g, swap: (text) => (text === 'true' ? 'false' : 'true') },
  { name: 'arithmetic', pattern: /(?<= )[+-](?= )/g, swap: (text) => (text === '+' ? '-' : '+') },
  { name: 'literal', pattern: /(?<![\w.$])\d+(?![\w.$])/g, swap: (text) => (Number(text) === 0 ? '1' : String(Number(text) - 1)) },
  { name: 'negation', pattern: /(?<![\w)\]!])!(?!=)/g, swap: () => '' },
];

/**
 * The source with comments and the inside of strings blanked to spaces, same length, newlines kept, so a pattern never
 * matches an operator that is only text.
 *
 * @param {string} source
 * @returns {string}
 */
export function masked(source) {
  let out = '';
  let state = 'code';
  // One entry per open ${ } inside a template: how many plain { are open within it.
  const frames = [];
  const blank = (char) => (char === '\n' ? char : ' ');
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    const next = source[at + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; at++; } else if (char === '/' && next === '*') { state = 'block'; out += '  '; at++; } else if (char === "'" || char === '"' || char === '`') { state = char; out += char; } else if (char === '{' && frames.length) { frames[frames.length - 1]++; out += char; } else if (char === '}' && frames.length) {
        if (frames[frames.length - 1] === 0) { frames.pop(); state = '`'; } else frames[frames.length - 1]--;
        out += char;
      } else out += char;
    } else if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; } else out += ' ';
    } else if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; at++; } else out += blank(char);
    } else if (char === '\\') {
      out += blank(char);
      if (next !== undefined) { out += blank(next); at++; }
    } else if (state === '`' && char === '$' && next === '{') { frames.push(0); state = 'code'; out += '${'; at++; } else if (char === state) { state = 'code'; out += char; } else if (char === '\n' && state !== '`') { state = 'code'; out += char; } else out += blank(char);
  }
  return out;
}

/**
 * Every single-line fault on the given lines, ordered by line then column.
 *
 * @param {string} source whole file text
 * @param {Iterable<number>} lineSet one-based lines allowed to change
 * @returns {Array<{ line: number, column: number, operator: string, before: string, after: string, mutated: string }>}
 *   before and after are the line's text; mutated is the whole file with only that line changed
 */
export function faults(source, lineSet) {
  const allowed = new Set(lineSet);
  const rows = source.split('\n');
  const blanked = masked(source).split('\n');
  const found = [];
  for (const line of [...allowed].sort((left, right) => left - right)) {
    const text = rows[line - 1];
    if (text === undefined) continue;
    for (const { name, pattern, swap } of OPERATORS) {
      for (const match of blanked[line - 1].matchAll(pattern)) {
        const replacement = swap(match[0]);
        if (replacement === undefined) continue;
        const after = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
        if (after === text) continue;
        const mutated = [...rows.slice(0, line - 1), after, ...rows.slice(line)].join('\n');
        found.push({ line, column: match.index + 1, operator: name, before: text, after, mutated });
      }
    }
  }
  return found.sort((left, right) => left.line - right.line || left.column - right.column);
}
