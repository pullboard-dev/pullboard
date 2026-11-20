/** Keep every engine identity in the one engines folder of the state cell, one leaf per engine [C7,V4]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { posix } from 'node:path';
import { engineBindings } from '../../../../kernel/light.js';
import { lex } from '../../../../kernel/light.js';


/** The one folder engine leaves live in; a leaf anywhere else, or a declaration outside it and src/, is refused. */
const ENGINE_FOLDER = 'packages/state/src/logic/engines';
/**
 * A path where an engine may be declared: a leaf in the engines folder, or one of the two legacy constant modules the
 * layout freeze moved out of the root src/ folder (src/move-engine-constants.js and src/engine-metadata.js) [V32].
 */
const HOME = new RegExp(`^(?:${ENGINE_FOLDER}/[^/]+|packages/state/src/logic/move/constants|packages/state/src/io/engine/metadata)\\.[cm]?js$`, 'u');

/** Name reserved engine declarations in source, excluding filenames and imported re-exports. */
export function engineDeclarationNames(source) {
  return engineBindings(lex(source).code).map(binding => binding[0]);
}

/** Prove the one approved pure state metadata chain still names its original root declaration. */
function stateExitRuleExport(sources, file, seen = new Set()) {
  if (seen.has(file) || seen.size >= 16) return false;
  seen.add(file);
  const rows = sources.filter(row => row.file === file);
  if (rows.length !== 1) return false;
  const { code, strings } = lex(rows[0].source);
  const declarations = engineBindings(code);
  if (file === `${ENGINE_FOLDER}/exit-rules-engine.js`) {
    return declarations.some(binding => binding[0] === 'EXIT_RULES_ENGINE')
      && /\bexport\s+const\s+EXIT_RULES_ENGINE\s*=/u.test(code);
  }
  if (file !== 'packages/state/light.js' && !/^packages\/state\/src\/logic\/[\w/-]+\.[cm]?js$/u.test(file)) return false;
  if (declarations.some(binding => binding[0] === 'EXIT_RULES_ENGINE')) return false;
  const literals = new Map(strings.map(literal => [literal.start, literal.text]));
  const targets = [];
  for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    if (!list[1].split(',').some(entry => entry.trim() === 'EXIT_RULES_ENGINE')) continue;
    const end = list.index + list[0].length;
    const from = /^\s*from\b\s*/u.exec(code.slice(end));
    const target = from ? literals.get(end + from[0].length) : null;
    if (!target || !/^\.{1,2}\//u.test(target) || target.includes('\\')) return false;
    targets.push(posix.normalize(posix.join(posix.dirname(file), target)));
  }
  return targets.length === 1 && stateExitRuleExport(sources, targets[0], seen);
}

/** The state cell's two front doors, either of which may forward an engine leaf. */
const STATE_DOORS = new Set(['packages/state/index.js', 'packages/state/light.js']);

/** The pure module light.js re-exports its engine numbers from; it forwards leaf numbers the way the doors do [C7,H16]. */
const ENGINE_NUMBER_DOOR = 'packages/state/src/logic/engine/constants.js';

/** Every name a leaf in the engines folder declares with `export const`, the only source of an engine's identity. */
function leafEngineNames(sources) {
  const names = new Set();
  for (const row of sources) {
    if (!row.file.startsWith(`${ENGINE_FOLDER}/`)) continue;
    for (const match of lex(row.source).code.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*_ENGINE)\b/gu)) names.add(match[1]);
  }
  return names;
}

/**
 * The names a state cell file reads by number from their own leaf, as `const NAME = engineNumber('NAME')`, each with
 * where its name stands [C7]. Why: the doors read leaf numbers as text so no leaf module loads; the name still has to be a
 * leaf's own declaration, so this is a forwarding like a named re-export, never a second declaration.
 */
function forwardedEngineNumbers(file, code, literals, leaves) {
  if (!file.startsWith('packages/state/')) return [];
  const found = [];
  for (const match of code.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_ENGINE)\s*=\s*engineNumber\(\s*/gu)) {
    const at = match.index + match[0].length;
    const literal = literals.get(at);
    if (literal === match[1] && /^.{2}\s*\)/su.test(code.slice(at + literal.length)) && leaves.has(match[1])) found.push({ name: match[1], index: match.index + match[0].indexOf(match[1]) });
  }
  return found;
}

/** Trust only the state front doors' exact named forwarding of an existing canonical leaf declaration. */
function stateEngineExports(sources) {
  const names = new Set();
  const leaves = leafEngineNames(sources);
  for (const entry of sources.filter(row => STATE_DOORS.has(row.file) || row.file === ENGINE_NUMBER_DOOR)) {
    for (const name of doorEngineExports(sources, entry.source, posix.dirname(entry.file))) names.add(name);
    const { code, strings } = lex(entry.source);
    for (const { name } of forwardedEngineNumbers(entry.file, code, new Map(strings.map(literal => [literal.start, literal.text])), leaves)) names.add(name);
  }
  return names;
}

/** The engine names one state front door, or the engine-number door, forwards straight from a leaf that declares them; `base` is the folder its relative targets start from. */
function doorEngineExports(sources, source, base) {
  const { code, strings } = lex(source), names = new Set();
  const literals = new Map(strings.map(literal => [literal.start, literal.text]));
  for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    const end = list.index + list[0].length, from = /^\s*from\b\s*/u.exec(code.slice(end));
    const target = from ? literals.get(end + from[0].length) : null;
    if (!target || !/^\.{1,2}\//u.test(target) || target.includes('\\')) continue;
    const file = posix.normalize(posix.join(base, target));
    if (!HOME.test(file)) continue;
    const definitions = sources.filter(row => row.file === file);
    if (definitions.length !== 1) continue;
    const canonical = lex(definitions[0].source).code;
    for (const entry of list[1].split(',')) {
      const name = /^([A-Z][A-Z0-9_]*_ENGINE)$/u.exec(entry.trim())?.[1];
      if (name && new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name}\\b`, 'u').test(canonical)) names.add(name);
    }
  }
  return names;
}

/** Find declarations that would split the existing engine folder during a package move. */
export function engineFolderViolations(sources) {
  const problems = [], stateExports = stateEngineExports(sources), leaves = leafEngineNames(sources);
  for (const { file, source } of sources) {
    if (!/^(?:src|packages|apps)\//u.test(file)) continue;
    // App journeys are the old root test/ folder, which this check never read: they import engine constants, never declare them [V32].
    if (/^apps\/[^/]+\/journeys\//u.test(file)) continue;
    if (HOME.test(file)) continue;
    const { code, strings } = lex(source);
    const literals = new Map(strings.map(literal => [literal.start, literal.text]));
    const forwarded = new Set(forwardedEngineNumbers(file, code, literals, leaves).map(({ index }) => index));
    const declarations = engineBindings(code).filter(match => !forwarded.has(match.index));
    const declared = new Set(declarations.map(match => match[0]));
    for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
      const end = list.index + list[0].length;
      const from = /^\s*from\b\s*/u.exec(code.slice(end));
      const target = from ? literals.get(end + from[0].length) : null;
      const entries = list[1].split(',');
      const targetFile = target && /^\.{1,2}\//u.test(target) && !target.includes('\\')
        ? posix.normalize(posix.join(posix.dirname(file), target)) : null;
      if (targetFile && HOME.test(targetFile)
        && !entries.some(entry => /(?:^|\bas\s+)EXIT_RULES_ENGINE\s*$/u.test(entry.trim())
          && !stateExitRuleExport(sources, targetFile))) continue;
      for (const entry of entries) {
        const exported = /(?:^|\bas\s+)([A-Z][A-Z0-9_]*_ENGINE)\s*$/u.exec(entry.trim());
        if (!exported || declared.has(exported[1])) continue;
        if (target && /^\.{1,2}\//u.test(target) && !target.includes('\\')
          && STATE_DOORS.has(posix.normalize(posix.join(posix.dirname(file), target)))
          && entry.trim() === exported[1] && stateExports.has(exported[1])) continue;
        if (target && /^\.{1,2}\//u.test(target) && !target.includes('\\')
          && entry.trim() === 'EXIT_RULES_ENGINE'
          && stateExitRuleExport(sources, posix.normalize(posix.join(posix.dirname(file), target)))) continue;
        declarations.push({ 0: exported[1], index: list.index });
        declared.add(exported[1]);
      }
    }
    if (declarations.length) {
      for (const match of declarations) problems.push({ file, line: code.slice(0, match.index).split('\n').length,
        text: `${match[0]} must be declared in its own leaf in ${ENGINE_FOLDER}; move the feature without its engine declaration` });
    } else if (/-engine\.js$/u.test(file)) {
      problems.push({ file, line: 1, text: `engine leaves live directly in ${ENGINE_FOLDER}; move the feature without its engine leaf` });
    }
  }
  return problems;
}

/** Read only product source trees; fixture text is lexed without running any module. */
export function engineFolderProblems(root) {
  const sources = [];
  const pending = ['src', 'packages', 'apps'].filter(folder => fileSystemAdapter().exists(join(root, folder)));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fileSystemAdapter().list(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') pending.push(file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(file)) sources.push({ file, source: fileSystemAdapter().readFile(join(root, file), 'utf8') });
    }
  }
  return engineFolderViolations(sources).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}
