/**
 * A small JavaScript lexer shared by Pullboard's Rigor checks and Rigor's quality rules [D1,C7]:
 * it splits code from strings, templates, regular expressions and comments without running
 * anything. It lives in src so a copy of src alone still runs every rule; bin/checks/scan.js
 * re-exports it for the checks.
 */

/** A word before `/` that means a regular expression follows, not a division. */
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Split JavaScript into code, strings and comments, without running it. `code` is the source with
 * the inside of every string, template text, regular expression and comment blanked to spaces
 * (newlines kept), so a pattern run over it only ever sees real code at its real offsets. A
 * template's `${...}` expressions stay code. Each string and template is listed whole, with its
 * text between the quotes; each comment with its span.
 *
 * Why a lexer: test files write fixture tests and catches inside strings, and a plain text search
 * would count those as the test file's own.
 *
 * @param {string} source
 * @returns {{ code: string, strings: { start: number, end: number, text: string }[], comments: { start: number, end: number }[] }}
 */
export function lex(source) {
  const code = source.split('');
  const strings = [];
  const comments = [];
  // Each open template, with the brace depth of its innermost `${` expression.
  const templates = [];
  let previous = '';
  const blank = (from, to) => { for (let at = from; at < to; at += 1) if (code[at] !== '\n') code[at] = ' '; };
  let at = 0;
  /** Scan template text from `at` to its end or its next `${`; returns true when the template closed. */
  const templateText = () => {
    const open = templates[templates.length - 1];
    while (at < source.length) {
      const char = source[at];
      if (char === '\\') { at += 2; continue; }
      if (char === '`') {
        blank(open.textFrom, at);
        strings.push({ start: open.start, end: at + 1, text: source.slice(open.start + 1, at) });
        templates.pop();
        at += 1;
        previous = '`';
        return;
      }
      if (char === '$' && source[at + 1] === '{') {
        blank(open.textFrom, at);
        open.depth = 0;
        at += 2;
        previous = '{';
        return;
      }
      at += 1;
    }
    blank(open.textFrom, source.length);
    templates.pop();
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at);
      comments.push({ start: at, end });
      blank(at, end);
      at = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', at + 2);
      const end = close === -1 ? source.length : close + 2;
      comments.push({ start: at, end });
      blank(at, end);
      at = end;
      continue;
    }
    if (char === '\'' || char === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      strings.push({ start: at, end: end + 1, text: source.slice(at + 1, end) });
      blank(at + 1, end);
      at = end + 1;
      previous = char;
      continue;
    }
    if (char === '`') {
      templates.push({ start: at, textFrom: at + 1, depth: -1 });
      at += 1;
      templateText();
      continue;
    }
    if (char === '/' && regexAllowed(previous)) {
      let end = at + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n') {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        else if (source[end] === '/' && !inClass) break;
        end += 1;
      }
      blank(at + 1, end);
      at = end + 1;
      previous = '/';
      continue;
    }
    const open = templates[templates.length - 1];
    if (open && open.depth >= 0) {
      if (char === '{') open.depth += 1;
      else if (char === '}') {
        if (open.depth === 0) {
          open.depth = -1;
          open.textFrom = at + 1;
          at += 1;
          templateText();
          continue;
        }
        open.depth -= 1;
      }
    }
    if (/[\w$]/u.test(char)) {
      let end = at;
      while (end < source.length && /[\w$]/u.test(source[end])) end += 1;
      previous = source.slice(at, end);
      at = end;
      continue;
    }
    if (!/\s/u.test(char)) previous = char;
    at += 1;
  }
  return { code: code.join(''), strings, comments };
}

/** True when a `/` after this token starts a regular expression rather than dividing. */
function regexAllowed(previous) {
  if (!previous) return true;
  if (/^[\w$]+$/u.test(previous)) return KEYWORDS.has(previous);
  return !/^[)\]'"`]$/u.test(previous) && previous !== '/';
}

/**
 * The 1-based line of an offset.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
export function lineAt(source, offset) {
  let line = 1;
  for (let at = source.indexOf('\n'); at !== -1 && at < offset; at = source.indexOf('\n', at + 1)) line += 1;
  return line;
}
