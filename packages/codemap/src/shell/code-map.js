// scan.mjs: zero-dependency, regex-plus-lexer scanner for one JavaScript ES module.
// It masks strings, templates, regex literals and comments so brace matching and call detection
// see only code, then reads top-level declarations, JSDoc, imports, calls and side-effect markers.

import {
  execFileSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  posix,
  resolve,
} from 'node:path';

const KEYWORDS = new Set(('if for while switch catch function return typeof instanceof new delete void await yield ' +
  'else do try finally throw case default break continue in of let const var class extends super this import export ' +
  'async static get set with debugger').split(' '));
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_PREV_WORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|throw|delete|instanceof|new)$/;

/**
 * Mask a source text: every character inside a string, template chunk, regex literal or comment
 * becomes a space (newlines kept), so offsets and line numbers still match the original.
 * Also returns the comment spans, since JSDoc lives there.
 */
export function mask(src) {
  const out = src.split('');
  const comments = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const tmplStack = []; // brace depth at which each open ${ started
  let depth = 0; let i = 0; const n = src.length;
  let lastSig = ''; let lastSigEnd = 0; // last significant code char, for the regex-vs-divide decision
  const readString = (q, start) => { let k = start + 1; while (k < n && src[k] !== q) { if (src[k] === '\\') k++; if (src[k] === '\n' && q !== '`') break; k++; } return k; };
  /** Scan a template chunk from just after ` or }; returns index after the closing ` or after ${. */
  const readTemplate = (start) => {
    let k = start;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') return { end: k + 1, open: false };
      if (src[k] === '$' && src[k + 1] === '{') return { end: k + 2, open: true };
      k++;
    }
    return { end: n, open: false };
  };
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; comments.push([i, end]); blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; comments.push([i, end]); blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") { const e = readString(c, i); blank(i + 1, e); i = e + 1; lastSig = 'a'; continue; }
    if (c === '`') { const t = readTemplate(i + 1); blank(i + 1, t.open ? t.end - 2 : t.end - 1); if (t.open) { tmplStack.push(depth); depth++; } i = t.end; lastSig = 'a'; continue; }
    if (c === '}' && tmplStack.length && tmplStack[tmplStack.length - 1] === depth - 1) {
      tmplStack.pop(); depth--; const t = readTemplate(i + 1); blank(i + 1, t.open ? t.end - 2 : t.end - 1); if (t.open) { tmplStack.push(depth); depth++; } i = t.end; lastSig = 'a'; continue;
    }
    if (c === '/') {
      const before = src.slice(Math.max(0, lastSigEnd - 12), lastSigEnd);
      const isRegex = lastSig === '' || REGEX_PREV.has(lastSig) || REGEX_PREV_WORDS.test(before);
      if (isRegex) {
        let k = i + 1; let inClass = false;
        while (k < n && src[k] !== '\n') { if (src[k] === '\\') { k += 2; continue; } if (src[k] === '[') inClass = true; else if (src[k] === ']') inClass = false; else if (src[k] === '/' && !inClass) break; k++; }
        blank(i + 1, k); k++; while (/[a-z]/.test(src[k] || '')) k++; i = k; lastSig = 'a'; lastSigEnd = k; continue;
      }
    }
    if (c === '{') depth++; else if (c === '}') depth--;
    if (!/\s/.test(c)) { lastSig = /[\w$]/.test(c) ? 'a' : c; lastSigEnd = i + 1; }
    i++;
  }
  return { masked: out.join(''), comments };
}

/** Index of the bracket matching the one at `open` in masked text, or -1. */
export function matchBracket(m, open) {
  const o = m[open]; const cl = { '(': ')', '{': '}', '[': ']' }[o]; let d = 0;
  for (let k = open; k < m.length; k++) { if (m[k] === o) d++; else if (m[k] === cl) { d--; if (d === 0) return k; } }
  return -1;
}

/** Split a parameter list on depth-0 commas and name each parameter (destructured ones get their keys). */
export function parseParams(text) {
  const parts = []; let d = 0; let cur = '';
  for (const ch of text) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const t = p.trim().replace(/^\.\.\./, '');
    if (t.startsWith('{') || t.startsWith('[')) {
      const inner = t.slice(1, matchBracket(t, 0)).replace(/\{[^{}]*\}|\[[^[\]]*\]/g, '');
      return { name: null, destructured: inner.split(',').map((s) => s.trim().split(/[:=\s]/)[0]).filter(Boolean), raw: t };
    }
    return { name: t.split(/[=\s]/)[0], destructured: null, raw: t };
  });
}

/** Parse a JSDoc block: first sentence, @param names and types, @returns type, @throws. */
export function parseJsdoc(text) {
  const body = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n');
  const tagAt = body.search(/^\s*@/m);
  const desc = (tagAt < 0 ? body : body.slice(0, tagAt)).trim().replace(/\s+/g, ' ');
  const first = (desc.match(/^.*?[.!?](?=\s|$)/) || [desc])[0].slice(0, 200);
  const params = []; let returns = null; const throws = [];
  // a type may hold nested braces: {{ a: number }}; take a balanced {...}
  const tagRe = /@(param|arg|argument|returns?|throws)\b\s*/g; let m;
  while ((m = tagRe.exec(body))) {
    let k = m.index + m[0].length; let type = null;
    if (body[k] === '{') { let d = 0; let e = k; for (; e < body.length; e++) { if (body[e] === '{') d++; else if (body[e] === '}') { d--; if (d === 0) break; } } type = body.slice(k + 1, e).replace(/\s+/g, ' ').trim(); k = e + 1; }
    const rest = body.slice(k).split('\n')[0].trim();
    if (m[1] === 'returns' || m[1] === 'return') returns = type || rest.slice(0, 60);
    else if (m[1] === 'throws') throws.push(type || rest.slice(0, 60));
    else { const nm = (rest.match(/^\[?([\w$.]+)/) || [])[1]; if (nm) params.push({ name: nm, type, optional: rest.startsWith('[') }); }
  }
  return { summary: first, params, returns, throws, hasDesc: desc.length > 0 };
}

/** Line number (1-based) of an offset. */
function lineOf(lineStarts, off) { let lo = 0; let hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; }

/** Parse the import specifiers of one import clause into [{local, imported}] ('default' / '*' for those forms). */
function importNames(clause) {
  const names = []; const c = clause.trim();
  const ns = c.match(/\*\s+as\s+([\w$]+)/); if (ns) names.push({ local: ns[1], imported: '*' });
  const def = c.match(/^([\w$]+)\s*(,|$)/); if (def) names.push({ local: def[1], imported: 'default' });
  const br = c.match(/\{([^}]*)\}/);
  if (br) for (const s of br[1].split(',')) { const t = s.trim(); if (!t) continue; const [a, b] = t.split(/\s+as\s+/); names.push({ local: (b || a).trim(), imported: a.replace(/^type\s+/, '').trim() }); }
  return names;
}

/** Static patterns describe source text; a constructor name is not an executable network call here. */
const SE = {
  gitSpawn: /\b(?:spawnSync|spawn|execFileSync|execFile|execSync)\(\s*['"`]git['"`]/,
  procSpawn: /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\(/,
  fsWrite: /\b(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|copyFileSync|createWriteStream|symlinkSync|chmodSync|truncateSync|rmdirSync|cpSync|mkdtempSync|writeSync)\(|\b(?:fs|fsp|promises)\.(?:writeFile|appendFile|rename|rm|unlink|mkdir|copyFile|cp|mkdtemp)\(/,
  fsRead: /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|realpathSync|opendirSync|createReadStream)\(|\b(?:fs|fsp|promises)\.(?:readFile|readdir|stat|access)\(/,
  network: /\bfetch\(|\bhttps?\.(?:request|get|createServer)\(|\bcreateServer\(|\bnet\.(?:connect|createConnection|createServer)\(|\btls\.connect\(|new [W]ebSocket\(/,
  env: /\bprocess\.env\b/,
  exit: /\bprocess\.exit\(/,
  prints: /\bprocess\.(?:stdout|stderr)\.write\(|\bconsole\.(?:log|error|warn)\(/,
  boardOpen: /\b(?:openBoard|withBoard)\(/,
};
const SQL_WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/i;

/**
 * Scan one module's source. Returns its job line, imports, exports and top-level functions with
 * signatures, JSDoc, calls, throws and side-effect markers. `rel` is the repo-relative path.
 */
export function scanSource(rel, src) {
  const { masked: m, comments } = mask(src);
  const lineStarts = [0]; for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  // depth map: brace depth at every offset of masked code
  const depthAt = new Int32Array(m.length + 1); { let d = 0; for (let k = 0; k < m.length; k++) { depthAt[k] = d; if (m[k] === '{') d++; else if (m[k] === '}') d--; } depthAt[m.length] = d; }
  const jsdocBefore = (off) => {
    // the comment that ends right before `off` (only whitespace or `export`/`async` between)
    for (let k = comments.length - 1; k >= 0; k--) {
      const [a, b] = comments[k]; if (b > off) continue;
      const gap = src.slice(b, off); if (!/^\s*$/.test(gap)) return null;
      return src.slice(a, b).startsWith('/**') ? src.slice(a, b) : null;
    }
    return null;
  };
  // module job: the first top-level /** */ comment that is not attached to a declaration
  let job = null;
  for (const [a, b] of comments) {
    if (src.slice(a, a + 3) !== '/**' || depthAt[a] !== 0) continue;
    const next = src.slice(b).match(/^\s*(\S+)/)?.[1] || '';
    if (/^(export|function|async|class|let|var)$/.test(next)) break; // the first JSDoc belongs to code: no module comment
    if (next === 'const' && /^\s*const\s+[a-z]/.test(src.slice(b))) break;
    job = parseJsdoc(src.slice(a, b)).summary; break;
  }
  // imports
  const imports = []; let mm;
  const impRe = /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g; // from original; masked hides specifiers
  const live = (mm, word) => { const at = mm.index + mm[0].indexOf(word); return m.slice(at, at + word.length) === word; };
  while ((mm = impRe.exec(src))) { if (!live(mm, 'import')) continue; imports.push({ from: mm[3], names: importNames(mm[1]), dynamic: false }); }
  const sideRe = /(?:^|\n)\s*import\s+(['"])([^'"]+)\1/g; while ((mm = sideRe.exec(src))) if (live(mm, 'import')) imports.push({ from: mm[2], names: [], dynamic: false });
  const dynRe = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])([^'"]+)\2\s*\)|import\(\s*(['"])([^'"]+)\4\s*\)/g;
  while ((mm = dynRe.exec(src))) {
    if (!live(mm, 'import')) continue;
    if (mm[3]) imports.push({ from: mm[3], names: importNames('{' + mm[1] + '}'), dynamic: true });
    else if (!imports.some((x) => x.dynamic && x.from === mm[5])) imports.push({ from: mm[5], names: [], dynamic: true });
  }
  const reexports = [];
  const reRe = /(?:^|\n)\s*export\s+(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"]+)\2/g;
  while ((mm = reRe.exec(src))) { if (!live(mm, 'export')) continue; const names = mm[1].startsWith('{') ? importNames(mm[1]).map((x) => ({ exported: x.local, imported: x.imported })) : [{ exported: '*', imported: '*' }]; reexports.push({ from: mm[3], names }); imports.push({ from: mm[3], names: names.map((x) => ({ local: null, imported: x.imported })), dynamic: false, reexport: true }); }
  const exportList = new Set(); const listRe = /(?:^|\n)\s*export\s+\{([^}]*)\}\s*;?(?!\s*from)/g;
  while ((mm = listRe.exec(src))) { if (!live(mm, 'export') || /^\s*from/.test(src.slice(mm.index + mm[0].length))) continue; for (const x of importNames('{' + mm[1] + '}')) exportList.add(x.imported + '=>' + x.local); }

  // top-level functions and consts
  const fns = []; const values = [];
  const declRe = /(^|\n)([ \t]*)(export\s+)?(default\s+)?(async\s+)?function\s*(\*)?\s*([\w$]*)\s*\(/g;
  while ((mm = declRe.exec(m))) {
    const start = mm.index + mm[1].length; if (depthAt[start] !== 0) continue;
    const parenOpen = mm.index + mm[0].length - 1; const parenClose = matchBracket(m, parenOpen); if (parenClose < 0) continue;
    const braceOpen = m.indexOf('{', parenClose); const end = matchBracket(m, braceOpen);
    fns.push({ name: mm[7] || 'default', exported: !!mm[3], isDefault: !!mm[4], async: !!mm[5], generator: !!mm[6], kind: 'function', start, paramText: src.slice(parenOpen + 1, parenClose), bodyStart: braceOpen, end: end < 0 ? m.length : end + 1 });
  }
  const constRe = /(^|\n)(export\s+)?(const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*/g;
  while ((mm = constRe.exec(m))) {
    const start = mm.index + mm[1].length; if (depthAt[start] !== 0) continue;
    let k = mm.index + mm[0].length; const rest = m.slice(k, k + 400);
    const arrow = rest.match(/^(async\s+)?(?:function\s*\*?\s*[\w$]*\s*\(|\(|([\w$]+)\s*=>)/);
    if (arrow && (arrow[3] || isArrowOrFn(m, k + arrow[0].length - (arrow[3] ? 0 : 1), rest))) {
      let paramText = arrow[3] || ''; let p = k + arrow[0].length - 1; let pc = p;
      if (!arrow[3]) { pc = matchBracket(m, p); paramText = src.slice(p + 1, pc); } else pc = k + arrow[0].length;
      const after = m.slice(pc + 1).match(/^\s*(?::[^=]*)?(=>)?\s*/); const bodyStart = pc + 1 + after[0].length;
      let end;
      if (m[bodyStart] === '{') end = matchBracket(m, bodyStart) + 1; else end = endOfStatement(m, bodyStart);
      fns.push({ name: mm[4], exported: !!mm[2], isDefault: false, async: !!arrow[1], generator: false, kind: 'arrow', start, paramText, bodyStart, end });
    } else {
      values.push({ name: mm[4], exported: !!mm[2], start, line: lineOf(lineStarts, start), end: endOfStatement(m, k) });
    }
  }
  const classRe = /(^|\n)(export\s+)?(default\s+)?class\s+([\w$]+)/g;
  while ((mm = classRe.exec(m))) { const start = mm.index + mm[1].length; if (depthAt[start] !== 0) continue; const b = m.indexOf('{', start); values.push({ name: mm[4], exported: !!mm[2], isClass: true, start, line: lineOf(lineStarts, start), end: matchBracket(m, b) + 1 }); }
  const defRe = /(^|\n)export\s+default\s+(?!function|async\s+function|class)/g;
  while ((mm = defRe.exec(m))) { const start = mm.index + mm[1].length; values.push({ name: 'default', exported: true, start, line: lineOf(lineStarts, start), end: endOfStatement(m, start + mm[0].length) }); }
  for (const e of exportList) { const [imported] = e.split('=>'); for (const f of fns) if (f.name === imported) f.exported = true; for (const v of values) if (v.name === imported) v.exported = true; }

  // local-name -> target for call resolution
  const importMap = new Map(); for (const im of imports) for (const nm of im.names) if (nm.local) importMap.set(nm.local, { from: im.from, imported: nm.imported });
  const topNames = new Set(fns.map((f) => f.name));
  const childNames = new Set(); const fsNames = new Set();
  for (const im of imports) { if (im.from === 'node:child_process' || im.from === 'child_process') im.names.forEach((x) => childNames.add(x.local)); if (/^(node:)?fs(\/promises)?$/.test(im.from)) im.names.forEach((x) => fsNames.add(x.local)); }
  const netNames = new Set(); for (const im of imports) if (/^(node:)?(https?|http2|net|tls|dgram)$/.test(im.from)) im.names.forEach((x) => netNames.add(x.local));
  const childExecImported = [...imports].some((im) => /child_process/.test(im.from) && im.names.some((x) => x.imported === 'exec'));

  for (const f of fns) {
    const body = m.slice(f.bodyStart, f.end); const raw = src.slice(f.bodyStart, f.end);
    f.line = lineOf(lineStarts, f.start); f.endLine = lineOf(lineStarts, Math.max(f.start, f.end - 1)); f.loc = f.endLine - f.line + 1;
    const jd = jsdocBefore(f.start); f.jsdoc = jd ? parseJsdoc(jd) : null;
    f.params = parseParams(m.slice(0, 0) + f.paramText.replace(/\/\*[\s\S]*?\*\//g, ''));
    f.signature = `${f.async ? 'async ' : ''}${f.name}(${f.paramText.replace(/\s+/g, ' ').trim()})`;
    // calls: bare identifiers followed by ( that are not member accesses or keywords
    const calls = new Set(); const callRe = /(?<![\w$.])()([\w$]+)\s*\(/g; let c;
    while ((c = callRe.exec(body))) { const id = c[2]; if (KEYWORDS.has(id) || /^\d/.test(id)) continue; if (topNames.has(id) || importMap.has(id)) calls.add(id); }
    const nsRe = /(?<![\w$.])()([\w$]+)\.([\w$]+)\s*\(/g; while ((c = nsRe.exec(body))) { const t = importMap.get(c[2]); if (t && t.imported === '*') calls.add(c[2] + '.' + c[3]); }
    f.localCalls = [...calls];
    // throws and refusal codes (codes live in strings, so read the raw body)
    const th = new Set(); const thRe = /\bthrow\s+new\s+([\w$]+)\s*\(\s*(['"`]([A-Z][A-Z0-9_]+)['"`])?/g;
    while ((c = thRe.exec(raw))) th.add(c[3] ? `${c[1]}(${c[3]})` : c[1]);
    const rfRe = /\bnew\s+Refused\(\s*['"`]([A-Z][A-Z0-9_]+)/g; while ((c = rfRe.exec(raw))) th.add(`Refused(${c[1]})`);
    f.throws = [...th];
    // direct side effects
    const se = new Set();
    if (SE.gitSpawn.test(raw)) se.add('git');
    const procCall = childNames.size && [...childNames].some((nm) => new RegExp(`(^|[^\\w$.])${nm.replace('$', '\\$')}\\s*\\(`).test(body) || new RegExp(`\\b${nm}\\.(spawn|exec|fork)`).test(body));
    if (procCall && !(se.has('git') && !/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\(\s*(?!['"`]git)/.test(raw))) se.add('spawn');
    if (childExecImported && /(^|[^\w$.])exec\(/.test(body)) se.add('spawn');
    if (SE.fsWrite.test(body) && (fsNames.size || /\bfs\./.test(body))) se.add('fs-write');
    if (SE.fsRead.test(body) && (fsNames.size || /\bfs\./.test(body))) se.add('fs-read');
    if (SE.network.test(body) || [...netNames].some((nm) => new RegExp(`(^|[^\\w$.])${nm}(\\.\\w+)?\\s*\\(`).test(body))) se.add('network');
    if (SE.env.test(body)) se.add('env');
    if (SE.exit.test(body)) se.add('exit');
    if (SE.prints.test(body)) se.add('prints');
    if (SE.boardOpen.test(body)) se.add('board-open');
    if (SQL_WRITE.test(raw) && /\.(?:run|exec|prepare)\(/.test(body)) se.add('board-write');
    f.effects = [...se];
    delete f.paramText;
  }
  // effects of module top-level code (outside any top-level function), e.g. worker entry points
  let top = m; for (const f of [...fns].sort((a, b) => b.start - a.start)) top = top.slice(0, f.start) + ' '.repeat(f.end - f.start) + top.slice(f.end);
  const topEffects = [];
  if (SE.exit.test(top)) topEffects.push('exit'); if (SE.env.test(top)) topEffects.push('env'); if (SE.fsWrite.test(top)) topEffects.push('fs-write');
  if (SE.procSpawn.test(top) && childNames.size) topEffects.push('spawn'); if (SE.network.test(top)) topEffects.push('network');
  const exportsList = [
    ...fns.filter((f) => f.exported).map((f) => (f.isDefault ? 'default' : f.name)),
    ...values.filter((v) => v.exported).map((v) => v.name),
    ...reexports.flatMap((r) => r.names.map((x) => x.exported)),
  ];
  return {
    path: rel, job, topEffects, loc: lineStarts.length, chars: src.length,
    imports, reexports, exports: [...new Set(exportsList)],
    functions: fns, values: values.map(({ end, ...v }) => v),
  };
}

/** True when masked text at `p` opens a parameter list followed by =>, i.e. an arrow function. */
function isArrowOrFn(m, p, rest) {
  if (/^(async\s+)?function/.test(rest)) return true;
  if (m[p] !== '(') return false; const c = matchBracket(m, p); if (c < 0) return false;
  return /^\s*(?::[^=;]*)?=>/.test(m.slice(c + 1, c + 200));
}

/** End offset of a statement that starts at `k`: the first depth-0 `;` or a newline that is not a continuation. */
function endOfStatement(m, k) {
  let d = 0;
  for (let i = k; i < m.length; i++) {
    const ch = m[i];
    if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { d--; if (d < 0) return i; }
    else if (d === 0 && ch === ';') return i + 1;
    else if (d === 0 && ch === '\n') { const next = m.slice(i + 1).match(/^\s*(\S)/); if (!next || !/[.?:+\-*/&|,=)]/.test(next[1])) return i; }
  }
  return m.length;
}

const CODE_MAP_FORMAT = 1;
const EFFECT_KINDS = ['git', 'spawn', 'fs-read', 'fs-write', 'network', 'board-write', 'board-open', 'env', 'exit', 'prints'];
/** Quote regex syntax in an identifier before matching it as source text. */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** List JavaScript modules below one source directory in a stable repository order. */
function listJavaScript(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    return entry.isDirectory() ? listJavaScript(root, path) : (/\.(?:m?js)$/u.test(entry.name) ? [path] : []);
  }).sort();
}

/** Read bounded Git metadata without invoking a shell. */
function gitText(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
}

/** Pin source and importer-test bytes to the exact clean primary main commit being indexed. */
function requireSourcePin(root, commit) {
  if (gitText(root, ['branch', '--show-current']) !== 'main'
    || gitText(root, ['rev-parse', 'HEAD']) !== commit
    || gitText(root, ['rev-parse', 'main']) !== commit) {
    throw new Error('the primary source checkout is not at the requested main commit');
  }
  if (gitText(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', 'src', 'bin', 'test'])) {
    throw new Error('src/, bin/ or test/ differs from the committed main source');
  }
}

/** Read committed modes and object IDs once; NUL records preserve unusual input path names. */
function committedInputs(root, commit) {
  const inputs = new Map();
  for (const record of gitText(root, ['ls-tree', '-r', '-z', commit, '--', 'src', 'bin', 'test']).split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    const path = record.slice(separator + 1);
    if (!/^(?:src|bin)\/.*\.m?js$/u.test(path) && !/^test\/.*\.test\.m?js$/u.test(path)) continue;
    const metadata = record.slice(0, separator).split(' ');
    if (separator < 0 || metadata.length !== 3 || metadata[1] !== 'blob'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(metadata[2])) {
      throw new Error(`${path} differs from the committed main source`);
    }
    inputs.set(path, { mode: metadata[0], object: metadata[2] });
  }
  return inputs;
}

/** Validate the exact bytes consumed, including index-hidden edits and external symbolic targets. */
function readPinnedInput(root, path, inputs) {
  const expected = inputs.get(path);
  const file = join(root, path);
  const mode = lstatSync(file);
  if (!expected || !['100644', '100755'].includes(expected.mode) || !mode.isFile()
    || Boolean(mode.mode & 0o111) !== (expected.mode === '100755')) {
    throw new Error(`${path} differs from the committed main source`);
  }
  const bytes = readFileSync(file);
  const object = createHash(expected.object.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (object !== expected.object) throw new Error(`${path} differs from the committed main source`);
  return bytes.toString('utf8');
}

/** Resolve one relative import to a scanned source module; external packages stay unresolved. */
function resolveModule(from, specifier, modules) {
  if (!specifier.startsWith('.')) return null;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  for (const candidate of [target, `${target}.js`, `${target}.mjs`, posix.join(target, 'index.js')]) {
    if (modules.has(candidate)) return candidate;
  }
  return null;
}

/** Follow local re-exports until a function or value declaration is found. */
function exportedDefiner(modules, modulePath, name, seen = new Set()) {
  const key = `${modulePath}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const module = modules.get(modulePath);
  if (!module) return null;
  if (module.functions.some(fn => (fn.isDefault ? 'default' : fn.name) === name && fn.exported)) return { modulePath, name };
  if (module.values.some(value => value.name === name && value.exported)) return { modulePath, name, value: true };
  for (const reexport of module.reexports) {
    const target = resolveModule(modulePath, reexport.from, modules);
    if (!target) continue;
    for (const entry of reexport.names) {
      if (entry.exported === name) return exportedDefiner(modules, target, entry.imported, seen);
      if (entry.exported === '*') {
        const found = exportedDefiner(modules, target, name, seen);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Read only syntactic test imports, ignoring import-shaped text in comments and strings. */
function testImports(root, testPath, modules, inputs) {
  const source = readPinnedInput(root, testPath, inputs);
  const { masked } = mask(source);
  const found = new Set();
  const pattern = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/gu;
  let match;
  while ((match = pattern.exec(source))) {
    const offset = match.index + match[0].indexOf('import');
    if (masked.slice(offset, offset + 6) !== 'import') continue;
    const target = resolveModule(testPath, match[2], modules);
    if (target) found.add(target);
  }
  return [...found].sort();
}

/** Build module, export, import, function and test edges from a pinned main source tree. */
export function buildCodeMap(root, mainCommit) {
  const sourceRoot = resolve(root);
  const commit = String(mainCommit ?? '').trim();
  if (!/^[\da-f]{40,64}$/u.test(commit)) throw new Error('a full main commit is required to stamp the map');
  requireSourcePin(sourceRoot, commit);
  const files = [...listJavaScript(sourceRoot, 'src'), ...listJavaScript(sourceRoot, 'bin')].sort();
  const testPaths = listJavaScript(sourceRoot, 'test').filter(path => /\.test\.m?js$/u.test(path));
  const inputs = committedInputs(sourceRoot, commit);
  if (JSON.stringify([...inputs.keys()].sort()) !== JSON.stringify([...files, ...testPaths].sort())) {
    throw new Error('the scanned input paths differ from the committed main source');
  }
  const modules = new Map();
  let sourceChars = 0;
  for (const path of files) {
    const source = readPinnedInput(sourceRoot, path, inputs);
    sourceChars += source.length;
    modules.set(path, scanSource(path, source));
  }
  for (const module of modules.values()) {
    module.dependencies = [...new Set(module.imports.map(entry => resolveModule(module.path, entry.from, modules)).filter(Boolean))].sort();
    module.external = [...new Set(module.imports.map(entry => entry.from).filter(specifier => !specifier.startsWith('.')))].sort();
    module.importedBy = [];
  }
  for (const module of modules.values()) for (const dependency of module.dependencies) modules.get(dependency).importedBy.push(module.path);

  const functions = new Map();
  for (const module of modules.values()) for (const fn of module.functions) {
    fn.id = `${module.path}#${fn.name}`;
    fn.calls = [];
    fn.callers = [];
    fn.externalCalls = [];
    functions.set(fn.id, fn);
  }
  for (const module of modules.values()) {
    const imports = new Map();
    for (const entry of module.imports) for (const name of entry.names) {
      if (name.local) imports.set(name.local, { from: entry.from, imported: name.imported });
    }
    for (const fn of module.functions) for (const call of fn.localCalls) {
      if (call.includes('.')) {
        const [namespace, name] = call.split('.');
        const imported = imports.get(namespace);
        const target = imported && resolveModule(module.path, imported.from, modules);
        const found = target && exportedDefiner(modules, target, name);
        if (found && !found.value) fn.calls.push(`${found.modulePath}#${found.name}`);
        continue;
      }
      if (functions.has(`${module.path}#${call}`) && !imports.has(call)) {
        fn.calls.push(`${module.path}#${call}`);
        continue;
      }
      const imported = imports.get(call);
      if (!imported) continue;
      const target = resolveModule(module.path, imported.from, modules);
      if (!target) fn.externalCalls.push(`${imported.from}:${imported.imported}`);
      else {
        const found = exportedDefiner(modules, target, imported.imported);
        if (found && !found.value && functions.has(`${found.modulePath}#${found.name}`)) fn.calls.push(`${found.modulePath}#${found.name}`);
      }
    }
    for (const fn of module.functions) fn.calls = [...new Set(fn.calls)].sort();
  }
  for (const fn of functions.values()) for (const callee of fn.calls) functions.get(callee)?.callers.push(fn.id);
  for (const fn of functions.values()) fn.transitiveEffects = new Set(fn.effects.filter(effect => EFFECT_KINDS.includes(effect)));
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds += 1) {
    changed = false;
    for (const fn of functions.values()) for (const called of fn.calls) {
      const callee = functions.get(called);
      if (!callee) continue;
      for (const effect of callee.transitiveEffects) if (!fn.transitiveEffects.has(effect)) {
        fn.transitiveEffects.add(effect);
        changed = true;
      }
    }
  }

  const churn = new Map();
  try {
    const log = gitText(sourceRoot, ['log', '--since=7.days', '--no-merges', '--format=@%h', '--name-only', commit, '--', 'src', 'bin']);
    for (const row of log.split('\n')) {
      const path = row.trim();
      if (path && !path.startsWith('@')) churn.set(path, (churn.get(path) ?? 0) + 1);
    }
  } catch { /* Missing history leaves churn unknown at zero; source edges remain available. */ }

  const testsByModule = new Map([...modules.keys()].map(path => [path, []]));
  for (const testPath of testPaths) for (const target of testImports(sourceRoot, testPath, modules, inputs)) testsByModule.get(target)?.push(testPath);
  const serializedModules = [...modules.values()].map(module => ({
    path: module.path,
    job: module.job,
    loc: module.loc,
    chars: module.chars,
    dependencies: module.dependencies,
    importedBy: [...new Set(module.importedBy)].sort(),
    external: module.external,
    exports: module.exports,
    values: module.values.map(({ name, exported, line, isClass }) => ({ name, exported, line, ...(isClass ? { isClass } : {}) })),
    tests: [...new Set(testsByModule.get(module.path) ?? [])].sort(),
    functions: module.functions.map(fn => ({
      id: fn.id,
      name: fn.name,
      exported: fn.exported,
      async: fn.async,
      line: fn.line,
      endLine: fn.endLine,
      loc: fn.loc,
      signature: fn.signature,
      params: fn.params,
      summary: fn.jsdoc?.summary ?? null,
      jsdocParams: fn.jsdoc?.params ?? [],
      returns: fn.jsdoc?.returns ?? null,
      effects: fn.effects,
      transitiveEffects: [...fn.transitiveEffects].sort(),
      throws: fn.throws,
      calls: fn.calls,
      callers: [...new Set(fn.callers)].sort(),
    })),
    churn7d: churn.get(module.path) ?? 0,
  }));
  requireSourcePin(sourceRoot, commit);
  const hot = serializedModules.map(module => ({
    path: module.path,
    churn: module.churn7d,
    fanIn: module.importedBy.length,
    loc: module.loc,
    score: module.churn7d * Math.log2(2 + module.importedBy.length),
  })).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, 12);
  return {
    format: CODE_MAP_FORMAT,
    mainCommit: commit,
    sourceCommit: commit,
    sourceTree: gitText(sourceRoot, ['rev-parse', `${commit}^{tree}`]),
    generatedAt: new Date().toISOString(),
    sourceChars,
    moduleCount: serializedModules.length,
    functionCount: functions.size,
    testCount: testPaths.length,
    hot,
    modules: serializedModules,
  };
}

/** Atomically save the derived map outside the source tree after rechecking its main stamp. */
export function writeCodeMap(root, cacheFile, mainCommit) {
  const sourceRoot = resolve(root);
  const map = buildCodeMap(sourceRoot, mainCommit);
  requireSourcePin(sourceRoot, map.mainCommit);
  mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
  const temporary = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(map)}\n`, { mode: 0o600, flag: 'wx' });
    requireSourcePin(sourceRoot, map.mainCommit);
    renameSync(temporary, cacheFile);
  } finally {
    try { if (existsSync(temporary)) rmSync(temporary); } catch { /* A partial temp is harmless and never read as the cache. */ }
  }
  return map;
}

/** Rebuild the common derived cache for an exact main source commit. */
export function refreshCodeMap(root, mainCommit) {
  const commonDir = gitText(resolve(root), ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return writeCodeMap(root, join(commonDir, 'pullboard', 'code-map.json'), mainCommit);
}

/** Refresh after a completed landing only when the primary checkout is already on main. */
export function refreshLandedCodeMap(root) {
  const sourceRoot = resolve(root);
  if (gitText(sourceRoot, ['branch', '--show-current']) !== 'main') return null;
  return refreshCodeMap(sourceRoot, gitText(sourceRoot, ['rev-parse', 'main']));
}

/** Read only a map with the exact current commit stamp; malformed or stale caches miss safely. */
export function readCodeMap(cacheFile, mainCommit) {
  try {
    const map = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return map.format === CODE_MAP_FORMAT && map.mainCommit === mainCommit && map.sourceCommit === mainCommit
      && /^[\da-f]{40,64}$/u.test(map.sourceTree) && Array.isArray(map.modules) ? map : null;
  } catch { return null; }
}

/** Reuse a valid current cache or rebuild it from a clean primary source checkout. */
export function ensureCodeMap(root, cacheFile, mainCommit) {
  return readCodeMap(cacheFile, mainCommit) ?? writeCodeMap(root, cacheFile, mainCommit);
}

/** Render an effect label that states what static analysis cannot see. */
function effectLine(effects) {
  return `effects: ${effects.length ? effects.join(', ') : 'not detected'}; other effects: not detected`;
}

/** Format one scanned function with signature, JSDoc and its detected call/effect edges. */
function functionCard(fn) {
  const lines = [`- ${fn.signature} L${fn.line}`, `  ${fn.summary ?? '(no JSDoc)'}`];
  if (fn.returns) lines.push(`  returns: ${fn.returns}`);
  lines.push(`  ${effectLine(fn.transitiveEffects)}`);
  if (fn.throws.length) lines.push(`  refuses: ${fn.throws.join(', ')}`);
  if (fn.callers.length) lines.push(`  observed callers: ${fn.callers.slice(0, 5).map(id => id.replace(/^src\//u, '')).join(', ')}`);
  if (fn.calls.length) lines.push(`  observed calls: ${fn.calls.slice(0, 6).map(id => id.replace(/^src\//u, '')).join(', ')}`);
  return lines.join('\n');
}

/** Render one module card and its observed import/test edges. */
export function renderModuleCard(map, modulePath) {
  const module = map.modules.find(entry => entry.path === modulePath);
  if (!module) return null;
  const exported = module.functions.filter(fn => fn.exported);
  const privateFns = module.functions.filter(fn => !fn.exported);
  return [`## ${module.path} (${module.loc} lines, ${exported.length} exported functions)`,
    `main: ${map.mainCommit}`, module.job ?? '(no module comment)',
    `observed imports: ${module.dependencies.join(', ') || '-'}${module.external.length ? ` | ${module.external.join(', ')}` : ''}`,
    `observed importers: ${module.importedBy.join(', ') || 'not detected'}`,
    `tests with observed imports: ${module.tests.join(', ') || 'not detected'}`,
    ...exported.map(functionCard),
    ...(privateFns.length ? [`private functions: ${privateFns.slice(0, 16).map(fn => fn.name).join(', ')}${privateFns.length > 16 ? ', …' : ''}`] : []),
    'Effects the scan cannot see: not detected.'].join('\n');
}

/** Render a compact source overview stamped with the commit it describes. */
export function renderCodeMapOverview(map) {
  return [`# Pullboard code map (${map.mainCommit.slice(0, 12)})`,
    `${map.moduleCount} modules · ${map.functionCount} top-level functions · ${map.testCount} test files scanned for import edges`,
    'Hot spots: seven-day source churn × observed import fan-in',
    ...map.hot.slice(0, 8).map(entry => `  ${entry.path} — ${entry.churn} changes, ${entry.fanIn} importers, ${entry.loc} lines`),
    'Static edges are observations, not a complete call graph. Effects not covered by patterns: not detected.',
    'Use `pullboard map <module or function>` for a card or `pullboard map --for <item>` for a slice.'].join('\n');
}

/** Resolve an exact module or a unique function name without guessing among duplicates. */
export function resolveMapTarget(map, key) {
  const normalized = String(key ?? '').trim().replace(/^\.\//u, '');
  const module = map.modules.find(entry => entry.path === normalized || entry.path === `src/${normalized}`
    || entry.path.replace(/^src\//u, '').replace(/\.m?js$/u, '') === normalized.replace(/\.m?js$/u, ''));
  if (module) return { module: module.path, fn: null };
  const [pathHint, name] = normalized.includes('#') ? normalized.split('#', 2) : [null, normalized];
  const matches = map.modules.flatMap(entry => entry.functions.filter(fn => fn.name === name
    && (!pathHint || entry.path === pathHint || entry.path === `src/${pathHint}`)).map(fn => ({ module: entry.path, fn })));
  if (matches.length === 1) return matches[0];
  if (matches.length) return { ambiguous: matches.map(entry => entry.fn.id) };
  return null;
}

/** Render the selected module or function card and name ambiguous function matches. */
export function renderMapCard(map, key) {
  const target = resolveMapTarget(map, key);
  if (!target) return null;
  if (target.ambiguous) return `function "${key}" is ambiguous; use one of: ${target.ambiguous.join(', ')}`;
  const module = map.modules.find(entry => entry.path === target.module);
  if (!target.fn) return renderModuleCard(map, target.module);
  return [`## ${target.fn.id}`, `main: ${map.mainCommit}`, module.job ?? '(no module comment)',
    functionCard(target.fn), `module imports: ${module.dependencies.join(', ') || '-'}`,
    `tests with observed imports: ${module.tests.join(', ') || 'not detected'}`,
    'Effects the scan cannot see: not detected.'].join('\n');
}

/** Extract recognized repository source paths from an item's visible text. */
function itemPaths(item) {
  const text = `${item.item_title ?? ''}\n${item.item_criterion ?? ''}\n${item.item_brief ?? ''}\n${item.item_files ?? ''}`;
  const found = new Set([...text.matchAll(/\b(?:src|bin|test)\/[\w./-]+\.(?:m?js)\b/gu)].map(match => match[0]));
  if (/\bpullboard\s+map\b/u.test(text)) found.add('src/commands/map.js');
  return found;
}

/** Build a one-hop item slice with importer tests and an explicit approximate token cap. */
export function renderItemSlice(map, item, { budget = 4000 } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8000) throw new RangeError('item slice budget must be from 1 to 8000 tokens');
  const text = `${item.item_title ?? ''}\n${item.item_criterion ?? ''}\n${item.item_brief ?? ''}\n${item.item_files ?? ''}`;
  const seeds = itemPaths(item);
  const modules = new Map(map.modules.map(module => [module.path, module]));
  const selected = new Set([...seeds].filter(path => modules.has(path)));
  const namedFunctions = new Set(map.modules.flatMap(module => module.functions.map(fn => fn.name))
    .filter(name => new RegExp(`(^|[^\\w$])${escapeRegExp(name)}($|[^\\w$])`, 'u').test(text)));
  const selectedFunctions = map.modules.flatMap(module => module.functions.filter(fn => namedFunctions.has(fn.name)));
  const functionModules = new Set(selectedFunctions.map(fn => fn.id.slice(0, fn.id.lastIndexOf('#'))));
  for (const path of functionModules) selected.add(path);
  for (const path of new Set([...seeds, ...functionModules])) {
    const module = modules.get(path);
    if (module) for (const neighbor of [...module.dependencies, ...module.importedBy]) selected.add(neighbor);
  }
  for (const fn of selectedFunctions) for (const edge of [...fn.calls, ...fn.callers]) selected.add(edge.slice(0, edge.lastIndexOf('#')));
  const importingTests = [...new Set([...selected].flatMap(path => modules.get(path)?.tests ?? []))].sort();
  const cards = [...selected].sort().map(path => renderModuleCard(map, path)).filter(Boolean);
  const base = [`# Slice for #${item.item_id ?? '?'}`, `main: ${map.mainCommit}`, 'Effects the scan cannot see: not detected.'];
  const optional = [
    item.item_title ? `title: ${item.item_title}` : null,
    `named files: ${[...seeds].sort().join(', ') || 'not detected'}`,
    `functions named by the item: ${selectedFunctions.map(fn => fn.id).slice(0, 24).join(', ') || 'not detected'}`,
    `tests with observed imports of selected modules: ${importingTests.join(', ') || 'not detected'}`,
    ...cards,
  ].filter(Boolean);
  const format = lines => lines.join('\n\n');
  const complete = format([...base, ...optional]);
  const maxChars = budget * 4;
  if (complete.length <= maxChars) return complete;
  const omission = 'Omitted context is not evidence of no relationship.';
  const minimum = format([...base, omission]);
  const minimumBudget = Math.ceil(minimum.length / 4);
  if (minimum.length > maxChars) {
    throw new RangeError(`item slice budget too small for its source stamp and omission note; use at least ${minimumBudget} tokens`);
  }
  const kept = [...base];
  let omitted = false;
  for (const entry of optional) {
    if (format([...kept, entry, omission]).length <= maxChars) kept.push(entry);
    else omitted = true;
  }
  if (omitted) kept.push(omission);
  return format(kept);
}
