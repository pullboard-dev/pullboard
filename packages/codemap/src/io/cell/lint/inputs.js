/** Recognize finite executable and data inputs without evaluating repository modules [C7,CD62]. */
import { posix } from 'node:path';
import { lex } from '../../../../../kernel/index.js';
import { COMMAND_CANDIDATE } from '../../../../../kernel/index.js';
import { COMMAND_FILE } from '../../../../../kernel/index.js';
import { bindingReadsForModules } from '../uses.js';
import { fileSystemAdapter } from '../../../../../fs/index.js';

const fs = fileSystemAdapter();

const DISCOVERY = fs.readFile(new URL('../../../../../kernel/src/logic/discovery.js', import.meta.url), 'utf8');
const KERNEL_FRONT_DOOR = fs.readFile(new URL('../../../../../kernel/index.js', import.meta.url), 'utf8');
const KERNEL_LIGHT_DOOR = fs.readFile(new URL('../../../../../kernel/light.js', import.meta.url), 'utf8');

/** Resolve one literal module-relative input, excluding external URLs and parent escapes. */
function relativeInput(file, literal) {
  if (!literal.startsWith('.') || /[\\\x00-\x1f]/u.test(literal)) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), literal));
  return target.startsWith('../') || target === '..' ? null : target;
}

/** Read actual native import identities while erasing declarations from binding-use probes. */
function importBindings(info) {
  const body = info.code.split(''), names = new Map();
  for (const match of info.code.matchAll(/\bimport\s+([^;]*?)\s+from\s*(['"])[^'"]*\2\s*;?/gu)) {
    const literal = info.strings.find(row => row.start >= match.index && row.end <= match.index + match[0].length);
    const clause = /^\s*\{([^}]*)\}\s*$/u.exec(match[1]);
    if (literal && clause) for (const part of clause[1].split(',').map(value => value.trim()).filter(Boolean)) {
      if (/^[A-Za-z_$][\w$]*$/u.test(part)) names.set(part, literal.text);
    }
    if (literal && /\bprocess\b/u.test(match[1])) {
      const nativeProcess = literal.text === 'node:process' && /^(?:\s*process\s*|\s*\*\s+as\s+process\s*|\s*\{\s*default\s+as\s+process\s*\}\s*)$/u.test(match[1]);
      names.set('process', nativeProcess ? 'node:process' : 'unproven process import');
    }
    for (let at = match.index; at < match.index + match[0].length; at++) body[at] = ' ';
  }
  return { names, body: body.join('') };
}

/** Recognize the canonical discovered-command ABI, never every command-looking file on its own. */
function commandInputs(file, info, names, files) {
  const specifier = names.get('discovered');
  const viaNode = names.get('readdirSync') === 'node:fs';
  const viaAdapter = names.has('fileSystemAdapter') && relativeInput(file, names.get('fileSystemAdapter')) === 'packages/fs/index.js';
  if (!specifier || names.get('COMMAND_CANDIDATE') !== specifier || names.get('COMMAND_FILE') !== specifier || !(viaNode || viaAdapter)) return [];
  const provider = relativeInput(file, specifier);
  const legacy = specifier === '../discovery.js' && files.get(provider)?.toString('utf8') === DISCOVERY;
  const kernel = (provider === 'packages/kernel/index.js' && files.get(provider)?.toString('utf8') === KERNEL_FRONT_DOOR
    || provider === 'packages/kernel/light.js' && files.get(provider)?.toString('utf8') === KERNEL_LIGHT_DOOR)
    && files.get('packages/kernel/src/logic/discovery.js')?.toString('utf8') === DISCOVERY;
  if (!legacy && !kernel) return [];
  const folder = /\bconst\s+(\w+)\s*=\s*new\s+URL\(\s*(['"])[^'"]*\2\s*,\s*import\.meta\.url\s*\)/u.exec(info.code);
  const compact = info.code.replace(/\s/gu, '');
  const literal = folder && info.strings.find(row => row.start >= folder.index && row.end <= folder.index + folder[0].length);
  // The folder is listed with node:fs readdirSync, or with the list call of a fileSystemAdapter() from the fs front door [C7,#11560].
  const adapter = viaAdapter ? /\bconst\s+(\w+)\s*=\s*fileSystemAdapter\(\s*\)/u.exec(info.code)?.[1] : null;
  const lister = folder && (viaNode ? 'readdirSync(' + folder[1] + ')' : adapter ? adapter + '.list(' + folder[1] + ')' : null);
  if (!literal || !lister || !compact.includes('discovered(' + lister + ',COMMAND_CANDIDATE,COMMAND_FILE,')
    || !compact.includes('return()=>import(newURL(file,' + folder[1] + ').href)') || !compact.includes('loader(file)')) return [];
  const directory = relativeInput(file, literal.text + '/placeholder')?.replace(/placeholder$/u, '');
  if (!directory) return [];
  return [...files.keys()].filter(target => target.startsWith(directory)
    && !target.slice(directory.length).includes('/') && COMMAND_CANDIDATE.test(target.slice(directory.length))
    && COMMAND_FILE.test(target.slice(directory.length))).map(target => ({ target, specifier: './' + target.slice(directory.length), entryExports: ['run'], kind: 'command', guards: ['discovered', viaNode ? 'readdirSync' : 'fileSystemAdapter', 'URL'] }));
}

/** Capture only literal URL uses at real worker/process launches or native file-read calls. */
function urlInputs(file, info, names) {
  const result = [];
  for (const match of info.code.matchAll(/\bnew\s+URL\(\s*(['"])[^'"]*\1\s*,\s*import\.meta\.url\s*\)/gu)) {
    const literal = info.strings.find(row => row.start >= match.index && row.end <= match.index + match[0].length);
    if (!literal) continue;
    const before = info.code.slice(Math.max(0, match.index - 240), match.index);
    const direct = /\b(readFileSync|readFile)\s*\(\s*(?:fileURLToPath\s*\(\s*)?$/u.exec(before);
    const thread = /\bnew\s+(Worker)\s*\(\s*$/u.exec(before);
    const process = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(\s*process\.execPath\s*,\s*\[\s*fileURLToPath\s*\(\s*$/u.exec(before);
    const assigned = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(before);
    let consumer = direct?.[1], module = consumer ? names.get(consumer) : null;
    if (assigned) {
      const name = assigned[1].replaceAll('$', '\\$');
      const read = new RegExp('\\b(readFileSync|readFile)\\s*\\(\\s*' + name + '\\s*[,)]', 'u').exec(info.code);
      if (read) { consumer = read[1]; module = names.get(consumer); }
    }
    const worker = thread && names.get('Worker') === 'node:worker_threads'
      || process && names.get(process[1]) === 'node:child_process' && names.get('fileURLToPath') === 'node:url'
        && (!names.has('process') || names.get('process') === 'node:process');
    if (worker) consumer = thread?.[1] ?? process[1];
    else if (!['node:fs', 'node:fs/promises'].includes(module)) continue;
    const target = relativeInput(file, literal.text);
    if (target) result.push({ target, specifier: literal.text, kind: worker ? 'worker' : 'data',
      guards: ['URL', consumer, ...(assigned ? [assigned[1]] : []), ...(process || /fileURLToPath/u.test(before) ? ['fileURLToPath'] : []), ...(process ? ['process'] : [])],
      declarations: assigned ? [{ name: assigned[1], at: match.index - before.length + assigned.index + assigned[0].indexOf(assigned[1]) }] : [] });
  }
  return result;
}

/** Batch compile-only identity probes; shadowed, opaque and unresolved inputs never become proven reach. */
export function cellSourceInputs(modules, files) {
  const candidates = new Map(), probes = [];
  for (const { file, source } of modules) {
    const info = lex(source), { names, body } = importBindings(info);
    const rows = [...commandInputs(file, info, names, files), ...urlInputs(file, info, names)];
    if (!rows.length) continue;
    candidates.set(file, rows);
    const probeBody = body.split('');
    for (const row of rows) for (const declaration of row.declarations ?? []) {
      for (let at = declaration.at; at < declaration.at + declaration.name.length; at++) probeBody[at] = ' ';
    }
    probes.push({ file, source, body: probeBody.join(''), bindings: [...new Set(rows.flatMap(row => row.guards))].map(local => ({ local })) });
  }
  const reads = bindingReadsForModules(probes), result = new Map();
  for (const [file, rows] of candidates) result.set(file, rows.map(({ guards, declarations, ...row }) => {
    const unresolved = guards.filter(name => {
      const proof = reads.get(file)?.get(name);
      return !proof || proof.opaque || proof.potentialShadow || !proof.reads.length;
    });
    return unresolved.length ? { ...row, unresolved: `input bindings remain unproven: ${unresolved.join(', ')}` } : row;
  }));
  return result;
}
