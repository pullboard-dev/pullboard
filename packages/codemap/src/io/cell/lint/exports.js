/** Account for individual exports without executing modules; opaque uses remain per-entity debt [CD62,C7]. */
import { bindingReadsForModules } from '../uses.js';
import { cachedBindingMetadata } from '../uses.js';
import { warmAllBindingReads } from '../uses.js';
import { lex } from '../../../../../kernel/index.js';
import { testFile } from './inventory.js';

const ID = '[A-Za-z_$][\\w$]*';
/** Resolve only a previously compiler-checked literal edge at this declaration. */
function declarationTarget(info, match, edges) {
  const literal = info.strings.find(row => row.start >= match.index && row.end <= match.index + match[0].length);
  if (literal?.text.startsWith('node:')) return literal.text;
  return literal && !literal.text.includes('\\') ? edges.find(edge => edge.specifier === literal.text)?.target : null;
}

/** Read simple named bindings, retaining every unsupported binding as explicit uncertainty. */
function names(text) {
  return text.split(',').map(row => row.trim()).filter(Boolean).map(row => {
    const match = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`, 'u').exec(row);
    return match ? { local: match[1], name: match[2] ?? match[1] } : null;
  });
}

/** Read literal dynamic imports: `(await import('x')).name` and `const { a } = await import('x')` name exact exports; any other use is opaque. */
function dynamicUses(info, edges) {
  const uses = [], call = `import\\s*\\(\\s*['"][^'"]*['"]\\s*\\)`, seen = new Set();
  /** Resolve the literal inside the call that starts at `at` through the compiler-checked edge list. */
  function resolve(at, length) {
    const literal = info.strings.find(row => row.start >= at && row.end <= at + length);
    return literal && !literal.text.includes('\\') ? edges.find(edge => edge.specifier === literal.text)?.target : null;
  }
  const member = new RegExp(`\\(\\s*await\\s+(${call})\\s*\\)\\s*\\.\\s*(${ID})`, 'gu');
  for (const match of info.code.matchAll(member)) {
    const at = match.index + match[0].indexOf('import', 1), target = resolve(at, match[1].length);
    seen.add(at);
    if (target) uses.push({ target, names: [match[2]] });
  }
  const pattern = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*await\\s+(${call})`, 'gu');
  for (const match of info.code.matchAll(pattern)) {
    const at = match.index + match[0].lastIndexOf('import'), target = resolve(at, match[2].length);
    seen.add(at);
    if (!target) continue;
    const rows = match[1].split(',').map(row => row.trim()).filter(Boolean).map(row => new RegExp(`^(${ID})(?:\\s*:\\s*${ID})?$`, 'u').exec(row)?.[1] ?? null);
    uses.push({ target, names: rows.filter(Boolean), opaque: rows.includes(null) });
  }
  for (const match of info.code.matchAll(new RegExp(call, 'gu'))) {
    if (seen.has(match.index)) continue;
    const target = resolve(match.index, match[0].length);
    if (target) uses.push({ target, names: [], opaque: true });
  }
  return uses;
}

/** Describe compiler-validated exports and imports; never infer syntax from strings or comments. */
function bindings(source, edges) {
  const info = lex(source), exports = new Map(), imports = [], stars = [], unknown = [];
  let body = info.code.split('');
  /** Remove declaration spans before looking for a use of an imported binding. */
  function erase(match) { for (let at = match.index; at < match.index + match[0].length; at++) body[at] = ' '; }
  for (const match of info.code.matchAll(/\bimport\s+([^;]*?)\s+from\s*(['"])[^'"]*\2\s*;?/gu)) {
    const target = declarationTarget(info, match, edges), clause = match[1].trim();
    erase(match);
    if (!target) { unknown.push('unresolved import binding: ' + source.slice(match.index, match.index + match[0].length)); continue; }
    if (target.startsWith('node:')) continue;
    const namespace = /^\*\s+as\s+([\w$]+)$/u.exec(clause);
    if (namespace) imports.push({ target, name: '*', local: namespace[1] });
    else {
      const braces = /\{([^}]*)\}/u.exec(clause);
      if (braces) for (const row of names(braces[1])) {
        if (row) imports.push({ target, name: row.local, local: row.name }); else unknown.push('unsupported named import binding: ' + source.slice(match.index, match.index + match[0].length));
      }
      const first = /^([A-Za-z_$][\w$]*)/u.exec(clause);
      if (first) imports.push({ target, name: 'default', local: first[1] });
      if (!braces && !first) unknown.push('unsupported import binding');
    }
  }
  for (const match of info.code.matchAll(/\bexport\s+(\*\s*(?:as\s+([\w$]+)\s*)?|\{([^}]*)\})\s+from\s*(['"])[^'"]*\4\s*;?/gu)) {
    const target = declarationTarget(info, match, edges);
    erase(match);
    if (!target) { unknown.push('unresolved re-export binding'); continue; }
    if (match[2]) exports.set(match[2], { target, name: '*', namespace: true });
    else if (match[1].trim() === '*') stars.push(target);
    else for (const row of names(match[3])) {
      if (row) exports.set(row.name, { target, name: row.local }); else unknown.push('unsupported re-export binding: ' + source.slice(match.index, match.index + match[0].length));
    }
  }
  for (const match of info.code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/gu)) {
    erase(match);
    for (const row of names(match[1])) {
      if (!row) { unknown.push('unsupported local export binding: ' + source.slice(match.index, match.index + match[0].length)); continue; }
      const imported = imports.find(binding => binding.local === row.local);
      exports.set(row.name, imported ? { target: imported.target, name: imported.name, namespace: imported.name === '*' } : { local: row.local });
    }
  }
  for (const match of info.code.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/gu)) exports.set(match[1], { local: match[1] });
  for (const match of info.code.matchAll(/\bexport\s+(?:const|let|var)\s+/gu)) {
    let depth = 0, start = match.index + match[0].length;
    const declarations = [];
    for (let at = start; at <= info.code.length; at++) {
      const char = info.code[at];
      if ('({['.includes(char ?? ' ')) depth++;
      if (')}]'.includes(char ?? ' ')) depth--;
      if (depth === 0 && (char === ',' || char === ';' || at === info.code.length)) {
        declarations.push(info.code.slice(start, at)); start = at + 1;
        if (char !== ',') break;
      }
    }
    for (const declaration of declarations) {
      const first = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/u.exec(declaration);
      if (first) exports.set(first[1], { local: first[1] });
      else {
        const left = declaration.split('=')[0];
        for (const name of left.match(/[\p{ID_Start}_$][\p{ID_Continue}$]*/gu) ?? []) exports.set(name, { unresolved: true });
        unknown.push('destructured export bindings are conservatively unproven: ' + left.trim());
      }
    }
  }
  for (const match of info.code.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class)\s+([^\s({]+)/gu)) {
    if (!new RegExp(`^${ID}$`, 'u').test(match[1])) {
      exports.set(match[1], { unresolved: true }); unknown.push('non-ASCII export binding is conservatively unproven: ' + match[1]);
    }
  }
  if (/\bexport\s+default\b/u.test(info.code)) exports.set('default', { local: 'default' });
  return { exports, explicit: new Set(exports.keys()), imports, stars, unknown, dynamic: dynamicUses(info, edges), body: body.join('') };
}

/** Read simple namespace member accesses; any other occurrence is opaque, never blanket proven reach. */
function namespaceUse(body, local, read) {
  const members = new Set(), spans = [];
  const pattern = new RegExp(`\\b${local.replaceAll('$', '\\$')}\\s*\\.\\s*(${ID})`, 'gu');
  for (const match of body.matchAll(pattern)) if (read.reads.includes(match.index)) { members.add(match[1]); spans.push([match.index, match.index + match[0].length]); }
  return { members, opaque: read.potentialShadow || Boolean(read.opaque) || read.reads.some(at => !spans.some(([start, end]) => at >= start && at < end)), used: read.reads.length > 0 || read.potentialShadow || Boolean(read.opaque) };
}

/** Compute individual export debt plus per-export uncertainty for opaque namespace consumption. */
export function exportReachability(files, edges, reached) {
  const modules = new Map(), unknown = [], used = new Set(), opaque = new Set();
  for (const [file, imports] of edges) {
    if (testFile(file)) continue;
    const source = files.get(file).toString('utf8');
    const metadata = cachedBindingMetadata(source, imports, () => bindings(source, imports));
    modules.set(file, metadata);
    for (const reason of metadata.unknown) unknown.push({ file, reason });
  }
  // Export-star chains converge monotonically, including cycles; unresolved stars remain unknown.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, module] of modules) for (const target of module.stars) {
      const provider = modules.get(target);
      if (!provider) continue;
      for (const name of provider.exports.keys()) if (name !== 'default' && !module.exports.has(name)) {
        module.exports.set(name, { target, name }); changed = true;
      }
      for (const name of provider.exports.keys()) {
        const existing = module.exports.get(name);
        if (name !== 'default' && !module.explicit.has(name) && existing?.target !== target) existing.unresolved = true;
      }
    }
  }
  const pending = [];
  for (const [file, inputs] of edges) if (reached.has(file)) {
    for (const input of inputs) for (const name of input.entryExports ?? []) pending.push({ target: input.target, name, members: null, uncertain: false });
  }
  /** Preserve an explicit import's namespace member context through re-export front doors. */
  function enqueue(target, name, members = null, uncertain = false) { pending.push({ target, name, members, uncertain }); }
  const warmAll = warmAllBindingReads();
  const readsByModule = bindingReadsForModules([...modules].filter(([file]) => warmAll || reached.has(file)).map(([file, module]) =>
    ({ file, source: files.get(file).toString('utf8'), body: module.body, bindings: module.imports.map(({ local }) => ({ local })) })));
  for (const [file, module] of modules) {
    if (!reached.has(file)) continue;
    for (const use of module.dynamic) {
      for (const name of use.names) enqueue(use.target, name, null, Boolean(use.opaque));
      if (use.opaque) for (const name of modules.get(use.target)?.exports.keys() ?? []) enqueue(use.target, name, null, true);
    }
    const reads = readsByModule.get(file);
    for (const binding of module.imports) {
      const read = reads.get(binding.local);
      if (read.opaque || read.potentialShadow) unknown.push({ file, reason: `${binding.local}: ${read.opaque ?? 'possible shadow binding or write target; binding reads remain unproven'}` });
      const provider = modules.get(binding.target), descriptor = provider?.exports.get(binding.name);
      if (binding.name === '*' || descriptor?.namespace) {
        const use = namespaceUse(module.body, binding.local, read);
        if (!use.used) continue;
        if (binding.name === '*') {
          if (!read.potentialShadow && !read.opaque) for (const name of use.members) enqueue(binding.target, name);
          if (use.opaque) for (const name of provider?.exports.keys() ?? []) enqueue(binding.target, name, null, true);
        } else enqueue(binding.target, binding.name, use.members, use.opaque);
      } else if (read.reads.length || read.potentialShadow || read.opaque) {
        enqueue(binding.target, binding.name, null, read.potentialShadow || Boolean(read.opaque));
      }
    }
  }
  const visited = new Set();
  while (pending.length) {
    const { target, name, members, uncertain } = pending.pop(), key = `${target}#${name}`;
    const signature = JSON.stringify([key, [...(members ?? [])].sort(), uncertain]);
    if (visited.has(signature)) continue;
    visited.add(signature);
    const descriptor = modules.get(target)?.exports.get(name);
    if (target.startsWith('node:')) continue;
    if (!descriptor) { unknown.push({ file: target, reason: `missing export ${name}` }); continue; }
    if (uncertain || descriptor.unresolved) opaque.add(key); else used.add(key);
    if (descriptor.target) {
      if (descriptor.namespace) {
        for (const member of members ?? []) enqueue(descriptor.target, member, null, uncertain);
        if (uncertain || members === null) for (const member of modules.get(descriptor.target)?.exports.keys() ?? []) enqueue(descriptor.target, member, null, true);
      } else enqueue(descriptor.target, descriptor.name, members, uncertain || descriptor.unresolved === true);
    }
  }
  const debt = [];
  for (const [file, module] of modules) for (const name of module.exports.keys()) {
    const key = `${file}#${name}`;
    if (!used.has(key)) debt.push({ key, reason: opaque.has(key) ? 'opaque use does not prove export reachability' : 'export is not reached from an app import' });
  }
  return { debt, unknown };
}
