/** Keep engine identities outside moving cells until per-package engines are decided [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { lex } from '../../../../src/js-lex.js';

import { engineBindings } from "../core/engine-declarations.js";

/** Name reserved engine declarations in source, excluding filenames and imported re-exports. */
export function engineDeclarationNames(source) {
  return engineBindings(lex(source).code).map(binding => binding[0]);
}

/** Find declarations that would split the existing engine folder during a package move. */
export function engineFolderViolations(sources) {
  const problems = [];
  for (const { file, source } of sources) {
    if (!/^(?:src|packages|apps)\//u.test(file)) continue;
    if (/^src\/[^/]+\.[cm]?js$/u.test(file)) continue;
    const { code, strings } = lex(source);
    const literals = new Map(strings.map(literal => [literal.start, literal.text]));
    const declarations = engineBindings(code);
    const declared = new Set(declarations.map(match => match[0]));
    for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
      const end = list.index + list[0].length;
      const from = /^\s*from\b\s*/u.exec(code.slice(end));
      const target = from ? literals.get(end + from[0].length) : null;
      if (target && /^\.{1,2}\//u.test(target) && !target.includes('\\')
        && /^src\/[^/]+\.[cm]?js$/u.test(posix.normalize(posix.join(posix.dirname(file), target)))) continue;
      for (const entry of list[1].split(',')) {
        const exported = /(?:^|\bas\s+)([A-Z][A-Z0-9_]*_ENGINE)\s*$/u.exec(entry.trim());
        if (!exported || declared.has(exported[1])) continue;
        declarations.push({ 0: exported[1], index: list.index });
        declared.add(exported[1]);
      }
    }
    if (declarations.length) {
      for (const match of declarations) problems.push({ file, line: code.slice(0, match.index).split('\n').length,
        text: `${match[0]} must stay in src/ with the engine leaves; move the feature without its engine declaration` });
    } else if (/-engine\.js$/u.test(file)) {
      problems.push({ file, line: 1, text: 'engine leaves must stay directly in src/; move the feature without its engine leaf' });
    }
  }
  return problems;
}

/** Read only product source trees; fixture text is lexed without running any module. */
export function engineFolderProblems(root) {
  const sources = [];
  const pending = ['src', 'packages', 'apps'].filter(folder => existsSync(join(root, folder)));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') pending.push(file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(file)) sources.push({ file, source: readFileSync(join(root, file), 'utf8') });
    }
  }
  return engineFolderViolations(sources).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}
