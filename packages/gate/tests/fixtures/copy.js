/** Copy only the exercised canonical runner modules, not the complete shipped application [C7,V4]. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import {
  join,
  posix,
} from 'node:path';
import { copyPackageFiles } from '../../../runners/index.js';
import { runnerPackage } from '../../../runners/index.js';
import { importsIn } from '../../index.js';
import { createRunnerModuleParser } from '../../../runners/index.js';
import { runtimeUrls } from '../../../runners/index.js';

/** Literal paths a module loads through `const r = createRequire(import.meta.url)` and `r('./x.js')`; computed paths load at run time. */
function requireLiterals(source) {
  const names = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(\s*import\.meta\.url\s*\)/gu)].map(match => match[1]);
  return names.flatMap(name => [...source.matchAll(new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}\\s*\\(\\s*(['"])(\\.{1,2}/[^'"\\\\\\n]+)\\1\\s*\\)`, 'gu'))].map(match => match[2]));
}

/** Retain unchanged production code and discovered move/engine declarations used by its eager imports.
 * This is a private fixture copier, not a runtime attestation or a general computed-import closure proof.
 * Computed runner imports select the fixture's own tests; the move registry and engine scan need their
 * actual declarations. The real worker uses the existing bounded production package closure.
 * Command metadata validates its unchanged implementation paths without executing them.
 * Every copied executable module otherwise follows its literal imports and runtime-file URLs.
 * A fixture that runs its gate through the runner controller passes its entry in `seeds`; the closure follows its imports.
 */
export function copyFixtureRunner(source, destination, seeds = []) {
  const sourceRoot = realpathSync(source);
  const parser = createRunnerModuleParser();
  const files = new Set(['package.json', ...Object.keys(runnerPackage(source).files),
    ...['apps/cli/src/io/command-docs', 'apps/cli/src/io/documentation', 'apps/cli/src/io/documentation/events'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.json')).map(file => `${folder}/${file}`))]);
  // Command modules are seeded here, not into `files`, so their own imports (such as board/read.js) are followed and copied too.
  let pending = ['apps/cli/src/io/run/tests.js', ...seeds,
    ...['apps/cli/src/io/commands'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`)),
    ...['src/moves', 'packages/moves/src/logic/moves', 'packages/moves/src/io/moves'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`)),
    ...['packages/state/src/logic/engines'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('-engine.js')).map(file => `${folder}/${file}`))];
  try {
    while (pending.length) {
      const level = [...new Set(pending)].filter(file => !files.has(file));
      pending = [];
      const sources = level.map(file => readFileSync(join(source, file), 'utf8'));
      const imports = importsIn(sources, parser.parse);
      for (const [index, file] of level.entries()) {
        if (!lstatSync(join(source, file)).isFile() || lstatSync(join(source, file)).isSymbolicLink()
          || !realpathSync(join(source, file)).startsWith(sourceRoot + '/')) throw new Error(`unsafe fixture runtime: ${file}`);
        files.add(file);
        const runtime = runtimeUrls(sources[index], parser.parse) ?? [];
        // A createRequire literal inside a comment names no file, so one that does not resolve is skipped.
        const loaded = requireLiterals(sources[index]).filter(specifier => existsSync(join(source, posix.normalize(posix.join(posix.dirname(file), specifier)))));
        for (const specifier of [...imports[index], ...runtime, ...loaded]) {
          if (isBuiltin(specifier) || specifier === '(computed)') continue;
          if (!specifier.startsWith('.')) throw new Error(`fixture runner cannot resolve ${file}: ${specifier}`);
          const target = posix.normalize(posix.join(posix.dirname(file), specifier));
          // The export manifest exists only in a built tooling export; the scanner reads it as optional, so a source checkout lacks it.
          if (target === '.pullboard-runner-source.json' && !existsSync(join(source, target))) continue;
          if (target.startsWith('../') || !existsSync(join(source, target))) throw new Error(`fixture runtime path is unavailable: ${target}`);
          if (statSync(join(source, target)).isDirectory()) continue;
          if (/\.[cm]?js$/u.test(target)) pending.push(target);
          else files.add(target);
        }
      }
    }
  } finally { parser.close(); }
  for (const file of files) {
    if (!lstatSync(join(source, file)).isFile() || lstatSync(join(source, file)).isSymbolicLink()
      || !realpathSync(join(source, file)).startsWith(sourceRoot + '/')) throw new Error(`unsafe fixture runtime: ${file}`);
  }
  // This repository-only gate helper is not part of the published runner package; callers that
  // exercise its static preflight copy it explicitly into their private fixture.
  files.delete('packages/gate/tests/fixtures/budgets.js');
  return copyPackageFiles(source, destination, { files: [...files].sort() });
}
