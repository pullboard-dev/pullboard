/** Copy only the exercised canonical runner modules, not the complete shipped application [C7,V4]. */
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { copyPackageFiles } from '../packages/runners/index.js';
import { runnerPackage } from '../packages/runners/src/shell/runner-package.js';
import { importsIn } from '../packages/gate/index.js';
import { createRunnerModuleParser } from '../packages/runners/src/shell/runner-module-parser.js';
import { runtimeUrls } from '../packages/runners/src/core/runner-runtime-urls.js';

/** Retain unchanged production code and discovered move/engine declarations used by its eager imports.
 * This is a private fixture copier, not a runtime attestation or a general computed-import closure proof.
 * Computed runner imports select the fixture's own tests; the move registry and engine scan need their
 * actual declarations. The real worker uses the existing bounded production package closure.
 * Command metadata validates its unchanged implementation paths without executing them.
 * Every copied executable module otherwise follows its literal imports and runtime-file URLs.
 * The repository-only static checker also imports its unchanged test-source scanner; that one helper
 * is private fixture support, copied separately without widening the shipped package manifest.
 */
export function copyFixtureRunner(source, destination) {
  const sourceRoot = realpathSync(source);
  const parser = createRunnerModuleParser();
  const files = new Set(['package.json', ...Object.keys(runnerPackage(source).files),
    ...['src/command-docs', 'apps/cli/src/shell/command-docs'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.json')).map(file => `${folder}/${file}`)),
    ...['src/commands', 'apps/cli/src/shell/commands'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`))]);
  let pending = ['bin/run-tests.js',
    ...['src/moves', 'packages/moves/src/core/moves', 'packages/moves/src/shell/moves'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`)),
    ...readdirSync(join(source, 'src')).filter(file => file.endsWith('-engine.js')).map(file => `src/${file}`)];
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
        for (const specifier of [...imports[index], ...runtime]) {
          if (isBuiltin(specifier) || specifier === '(computed)') continue;
          if (!specifier.startsWith('.')) throw new Error(`fixture runner cannot resolve ${file}: ${specifier}`);
          const target = posix.normalize(posix.join(posix.dirname(file), specifier));
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
  const scanner = 'test/wall-clock-budgets.js';
  const copied = copyPackageFiles(source, destination, { files: [...files].filter(file => file !== scanner).sort() });
  if (files.has(scanner)) {
    mkdirSync(dirname(join(destination, scanner)), { recursive: true });
    copyFileSync(join(source, scanner), join(destination, scanner));
    copied.push(scanner);
  }
  return copied.sort();
}
