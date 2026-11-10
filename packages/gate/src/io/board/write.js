/** Resolve named source calls inside native SQLite writers without executing candidate modules [C7,CD39]. */
import { posix } from 'node:path';
import { scanSource } from '../../../../codemap/index.js';
import { lex } from '../../../../kernel/index.js';

const EXTERNAL_IO = /^(?:(?:node:)?(?:fs(?:\/promises)?|child_process|https?|net|tls|dns(?:\/promises)?|dgram)|global:network)$/u;
// These builtin address/header validators perform no network operation.
const PURE_NETWORK_CALLS = new Set(['net#isIP', 'net#isIPv4', 'net#isIPv6',
  'http#validateHeaderName', 'http#validateHeaderValue']);
// Exact relocation identities; permission names and I/O sets remain unchanged.
const STORE_WRITE_IDENTITIES = new Map([
  ['packages/store/src/io/board/write/lock.js', 'src/board-write-lock.js'],
  ['packages/store/src/io/receipts.js', 'src/proof-receipts.js'],
  ['packages/store/src/io/board/hold/log.js', 'src/board-hold-log.js'],
  ['src/gate-run-receipt.js', 'packages/gate/src/io/run/receipt.js'],
]);

/** Retain exact established function identities after relocation. */
function writeIdentity(key) {
  const at = key.lastIndexOf('#');
  return at < 0 ? key : (STORE_WRITE_IDENTITIES.get(key.slice(0, at)) ?? key.slice(0, at)) + key.slice(at);
}

/** The only approved in-transaction I/O boundaries: holder accuracy and live policy races. */
export const BOARD_WRITE_IO_EXCEPTIONS = Object.freeze({
  policy: 'apps/cli/src/io/read.js#writePolicySignature',
});

// Only the transaction kernel can call these after release; callers inside work are not exempt.
const POST_RELEASE = new Map([
  ['src/board-write-lock.js#finishBoardWrite', new Set(['node:fs#writeSync', 'node:fs#unlinkSync'])],
  // Coordinator 29 Oct 06:39: finishBoardWrite refuses !released before this bounded post-release log append.
  ['src/board-hold-log.js#recordBoardHold', new Set([
    'node:fs#mkdirSync', 'node:fs#openSync', 'node:fs#fstatSync', 'node:fs#writeSync', 'node:fs#closeSync',
  ])],
]);
// No deferred provider is exempt from the native writer audit.
export const PENDING_WRITE_REPAIRS = Object.freeze({});

/** Match nested source delimiters in lexed code, never interpreting string or comment contents. */
function closing(code, at) {
  const end = { '(': ')', '[': ']', '{': '}' }[code[at]];
  if (!end) return -1;
  const stack = [end];
  for (let index = at + 1; index < code.length; index++) {
    if ('([{'.includes(code[index])) stack.push({ '(': ')', '[': ']', '{': '}' }[code[index]]);
    else if (')]}'.includes(code[index])) {
      if (stack.pop() !== code[index]) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

/** Split a call's actual arguments, retaining their exact source ranges. */
function argumentsAt(code, open) {
  const end = closing(code, open);
  if (end < 0) return null;
  const ranges = [];
  let start = open + 1;
  for (let index = start; index <= end; index++) {
    if (index === end || code[index] === ',') { ranges.push([start, index]); start = index + 1; }
    else if ('([{'.includes(code[index])) {
      const close = closing(code, index);
      if (close < 0) return null;
      index = close;
    }
  }
  return ranges;
}

/** Collect direct calls, including namespace/default-import member calls and local aliases. */
function calls(code, source = code) {
  const found = [...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\(/gu)]
    .filter(match => !/\bfunction\s*$/u.test(code.slice(Math.max(0, match.index - 20), match.index)))
    .map(match => ({ name: match[1], at: match.index, open: match.index + match[0].lastIndexOf('(') }));
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[/gu)) {
    const open = match.index + match[0].lastIndexOf('['), close = closing(code, open);
    if (close < 0 || !/^\s*(?:\?\.)?\s*\(/u.test(code.slice(close + 1))) continue;
    const member = /^\s*(['"])([A-Za-z_$][\w$]*)\1\s*$/u.exec(source.slice(open + 1, close));
    found.push({ name: match[1] + '.' + (member?.[2] ?? '<computed>'), at: match.index, open: code.indexOf('(', close + 1) });
  }
  return found;
}

/** Read every named function declaration, including callbacks local to a native command. */
function functions(source, facts, code) {
  const found = new Map(facts.functions.map(row => [row.name, row]));
  for (const match of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (found.has(match[1])) continue;
    const open = match.index + match[0].lastIndexOf('('), end = closing(code, open);
    if (end < 0) continue;
    const bodyStart = code.indexOf('{', end + 1), bodyEnd = closing(code, bodyStart);
    if (bodyStart < 0 || bodyEnd < 0) continue;
    found.set(match[1], { name: match[1], start: match.index, bodyStart, end: bodyEnd + 1 });
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/gu)) {
    if (found.has(match[1])) continue;
    const bodyStart = match.index + match[0].length;
    let end = code[bodyStart] === '{' ? closing(code, bodyStart) + 1 : code.indexOf(';', bodyStart);
    if (end <= bodyStart) end = code.length;
    found.set(match[1], { name: match[1], start: match.index, bodyStart, end });
  }
  return found;
}

/**
 * Report forbidden named/imported I/O reached by actual atomic callback source.
 * @param {{file:string,source:string}[]} sources Runtime source inventory, not event or command output.
 * @param {{pending?:Record<string,number|{item:number,via:string}>}} [options] Exact coordinator-owned temporary repair boundaries.
 * @returns {{file:string,line:number,call:string,chain:string[]}[]}
 */
export function boardWriteIoProblems(sources, { pending = PENDING_WRITE_REPAIRS } = {}) {
  const modules = new Map();
  for (const { file, source } of sources) {
    if (!/^(?:src\/|packages\/[^/]+\/src\/|apps\/[^/]+\/)/u.test(file) || !/\.[cm]?js$/u.test(file)) continue;
    // Product source only: the old root test/ folder was never read, and it now lives in apps' journeys/ and tests/ [V32].
    if (!/(?:^|\/)src\//u.test(file) && /(?:^|\/)(?:tests?|journeys)\//u.test(file)) continue;
    const facts = scanSource(file, source), { code } = lex(source);
    // code-map's inventory is line-oriented; valid adjacent import declarations still need binding coverage.
    const importRows = [...facts.imports];
    for (const match of code.matchAll(/\bimport\s+(?=[\w*{])/gu)) {
      const end = code.indexOf(';', match.index);
      if (end >= 0) importRows.push(...scanSource(file, source.slice(match.index, end + 1)).imports);
    }
    const imports = new Map(importRows.flatMap(row => row.names.filter(name => name.local)
      .map(name => [name.local, { from: row.from, imported: name.imported }])));
    const aliases = new Map();
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/gu)) aliases.set(match[1], match[2]);
    modules.set(file, { file, source, code, facts, imports, aliases, functions: functions(source, facts, code) });
  }
  const problems = new Map();
  /** Temporary repairs are exact function names, optionally restricted to one actual writer. */
  function pendingRepair(key, chain) {
    const repair = pending[key] ?? pending[writeIdentity(key)];
    return typeof repair === 'number' || Boolean(repair && chain.some(identity => writeIdentity(identity) === repair.via));
  }
  /** Resolve only repository-relative modules and actual declarations/reexports, without module evaluation. */
  function exported(file, name, seen = new Set()) {
    const key = file + '#' + name;
    if (seen.has(key)) return [];
    seen.add(key);
    const model = modules.get(file);
    if (!model) return [];
    if (model.functions.has(name)) return [{ file, name }];
    const binding = model.imports.get(name);
    if (binding) return binding.from.startsWith('.')
      ? exported(posix.normalize(posix.join(posix.dirname(file), binding.from)), binding.imported, seen)
      : [{ builtin: binding.from, name: binding.imported }];
    const targets = [];
    for (const row of model.facts.reexports) {
      for (const symbol of row.names.filter(symbol => symbol.exported === name || symbol.exported === '*')) {
        if (row.from.startsWith('.')) targets.push(...exported(posix.normalize(posix.join(posix.dirname(file), row.from)), symbol.imported === '*' ? name : symbol.imported, new Set(seen)));
        else targets.push({ builtin: row.from, name: symbol.imported === '*' ? name : symbol.imported });
      }
    }
    return targets;
  }
  /** Follow named imports, namespace/default members and literal local aliases to their actual provider. */
  function targets(file, name, seen = new Set()) {
    const model = modules.get(file), key = file + '#' + name;
    if (!model || seen.has(key)) return [];
    seen.add(key);
    if (model.aliases.has(name)) return targets(file, model.aliases.get(name), seen);
    const [base, ...members] = name.split('.');
    const member = members.join('.') || null;
    if (model.aliases.has(base)) return targets(file, model.aliases.get(base) + (member ? '.' + member : ''), seen);
    const binding = model.imports.get(base);
    if (binding && (member || binding.imported !== '*')) {
      const symbol = member ?? binding.imported;
      return binding.from.startsWith('.')
        ? exported(posix.normalize(posix.join(posix.dirname(file), binding.from)), symbol)
        : [{ builtin: binding.from, name: symbol }];
    }
    if (model.functions.has(name)) return [{ file, name }];
    if (['fetch', 'WebSocket', 'EventSource', 'globalThis.fetch', 'globalThis.WebSocket', 'globalThis.EventSource'].includes(name)) {
      return [{ builtin: 'global:network', name: member ?? base }];
    }
    return [];
  }
  /** Keep direct source and its causal imported-call chain, without board data or private arguments. */
  function inspect(file, start, end, chain, visited) {
    const model = modules.get(file), body = model.code.slice(start, end);
    for (const call of calls(body, model.source.slice(start, end))) for (const target of targets(file, call.name)) {
      const key = target.file + '#' + target.name;
      if (target.builtin && EXTERNAL_IO.test(target.builtin)) {
        if (PURE_NETWORK_CALLS.has(target.builtin.replace(/^node:/u, '') + '#' + target.name)) continue;
        const owner = writeIdentity(chain.at(-1));
        if (writeIdentity(chain[0]) === 'packages/store/src/io/board/event/log.js#atomic'
          && chain.some(value => writeIdentity(value) === 'src/board-write-lock.js#finishBoardWrite')
          && POST_RELEASE.get(owner)?.has(target.builtin + '#' + target.name)) continue;
        if (chain[0] === BOARD_WRITE_IO_EXCEPTIONS.policy && chain.at(-1) === 'apps/cli/src/io/read.js#policyRefBytes'
          && target.builtin === 'node:fs' && target.name === 'readFileSync') continue;
        const firstArgument = argumentsAt(model.code, start + call.open)?.[0];
        if (writeIdentity(chain.at(-1)) === 'packages/store/src/io/board/event/log.js#atomic' && target.builtin === 'node:fs'
            && target.name === 'writeSync' && firstArgument
            && model.code.slice(...firstArgument).trim() === '2') continue; // Existing stderr-only cleanup diagnostic.

        const detail = { file, line: model.source.slice(0, start + call.at).split('\n').length,
          call: target.builtin + '#' + target.name, chain };
        problems.set(chain[0] + ':' + detail.file + ':' + detail.line + ':' + detail.call, detail);
      } else if (target.file && !visited.has(key) && !pendingRepair(key, chain)
          && writeIdentity(key) !== 'packages/store/src/io/board/event/log.js#atomic') {
        const next = modules.get(target.file), fn = next?.functions.get(target.name);
        if (fn) inspect(target.file, fn.bodyStart, fn.end, [...chain, key], new Set([...visited, key]));
      }
    }
  }
  for (const model of modules.values()) {
    const atomicNames = new Set([...model.imports].filter(([, value]) => value.imported === 'atomic').map(([name]) => name));
    for (const call of calls(model.code, model.source).filter(call => atomicNames.has(call.name) || call.name.endsWith('.atomic')
      || targets(model.file, call.name).some(target => writeIdentity(target.file + '#' + target.name) === 'packages/store/src/io/board/event/log.js#atomic'))) {
      const owner = [...model.functions.values()].filter(fn => fn.start <= call.at && fn.end > call.at).sort((a, b) => b.start - a.start)[0];
      if (owner && pendingRepair(model.file + '#' + owner.name, [model.file + '#' + owner.name])) continue;
      const args = argumentsAt(model.code, call.open);
      if (!args?.[1]) continue;
      const [start, end] = args[1], body = model.code.slice(start, end);
      const chain = [model.file + ':' + model.source.slice(0, call.at).split('\n').length,
        ...(owner ? [model.file + '#' + owner.name] : [])];
      if (/^\s*[A-Za-z_$][\w$]*\s*$/u.test(body)) {
        const providers = targets(model.file, body.trim());
        if (!providers.length) problems.set(chain[0], { file: model.file, line: model.source.slice(0, call.at).split('\n').length, call: 'unresolved atomic callback', chain });
        for (const target of providers) {
          if (target.builtin && EXTERNAL_IO.test(target.builtin)) problems.set(chain[0], {
            file: model.file, line: model.source.slice(0, call.at).split('\n').length, call: target.builtin + '#' + target.name, chain });
          const next = modules.get(target.file), fn = next?.functions.get(target.name);
          if (fn) inspect(target.file, fn.bodyStart, fn.end, [...chain, target.file + '#' + target.name], new Set());
        }
      } else if (/=>|\bfunction\b/u.test(body)) inspect(model.file, start, end, chain, new Set());
      else problems.set(chain[0], { file: model.file, line: model.source.slice(0, call.at).split("\n").length, call: "unresolved atomic callback", chain });
    }
  }
  // Call-site callbacks do not include the transaction implementation's own post-acquisition work.
  // Its process identity preparation intentionally stays before BEGIN, outside this held-lock range.
  for (const transaction of [modules.get('packages/store/src/io/board/event/log.js')]) {
    const implementation = transaction?.functions.get('atomic');
    if (implementation) {
      const body = transaction.code.slice(implementation.bodyStart, implementation.end);
      const acquisition = calls(body).find(call => call.name === 'beginImmediateQueued');
      if (acquisition) {
        const end = closing(body, acquisition.open);
        if (end >= 0) inspect(transaction.file, implementation.bodyStart + end + 1, implementation.end,
          [transaction.file + '#' + implementation.name], new Set([transaction.file + '#' + implementation.name]));
      }
    }
  }
  // The policy provider is installed dynamically, so audit its exact named witness explicitly.
  const policy = modules.get('apps/cli/src/io/read.js');
  const witness = policy?.functions.get('writePolicySignature');
  if (witness) inspect(policy.file, witness.bodyStart, witness.end,
    [BOARD_WRITE_IO_EXCEPTIONS.policy], new Set([BOARD_WRITE_IO_EXCEPTIONS.policy]));
  return [...problems.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.call.localeCompare(b.call));
}
