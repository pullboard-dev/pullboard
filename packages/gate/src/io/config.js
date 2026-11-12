/** Project gate detection and configuration, without executing the chosen command [I1,I2,A1]. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  loadConfig,
} from '../../../config/index.js';
import { repoInfo } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/** Detect an existing ecosystem's test command without executing it during setup. */
export function detectGate(root) {
  const file = join(root, 'package.json');
  if (existsSync(file)) {
    try {
      const test = JSON.parse(readFileSync(file, 'utf8'))?.scripts?.test;
      if (typeof test === 'string' && test.trim() && test.trim() !== NPM_DEFAULT_TEST) return 'npm test';
    } catch { /* An unreadable package does not hide another ecosystem. */ }
  }
  if (existsSync(join(root, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo test';
  if (['pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'].some((name) => existsSync(join(root, name)))) return 'pytest';
  for (const [name, section] of [['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    if (existsSync(join(root, name)) && readFileSync(join(root, name), 'utf8').includes(`[${section}]`)) return 'pytest';
  }
  for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
    if (!existsSync(join(root, name))) continue;
    return makeHasTest(readFileSync(join(root, name), 'utf8')) ? 'make test' : '';
  }
  return '';
}

/** Read literal rule target lists without executing Makefile parsing, includes or recipes. */
function makeHasTest(source) {
  return source.replace(/\\\r?\n/gu, ' ').split(/\r?\n/u).some((line) => {
    if (line.startsWith('\t')) return false;
    const targets = /^([^:#=]+):(?!(?::)*=)/u.exec(line)?.[1];
    return targets?.trim().split(/[ \t]+/u).includes('test') ?? false;
  });
}

/** Quote the whole gate command as one shell argument, including embedded quotes. */
export function settingCommand(root, command = detectGate(root) || 'pullboard spec check') {
  return `pullboard gate set '${command.replaceAll("'", "'\\''")}'`;
}

/** Refuse an empty gate with a project-specific next step rather than a substitute check. */
export function missingGate(root) {
  const next = `in the main checkout, run ${settingCommand(root)}, then commit ${CONFIG_FILE}`;
  return new Refused('NO_GATE', `no gate configured; ${next}`, next);
}

/** Set only the coordinator's gate field; running and trusting it remain separate commands. */
export function setHere(io, command, rest, values) {
  if (typeof command !== 'string' || !command.trim() || rest.length || values.landing) {
    throw new Refused('USAGE', 'set the gate with one quoted argument: pullboard gate set "<command>"', 'pullboard gate set "<command>"');
  }
  const info = repoInfo(io.cwd);
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'the project gate belongs to the coordinator', 'ask the coordinator to run pullboard gate set "<command>" in the main checkout');
  }
  loadConfig(info.root);
  const file = join(info.root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.gate = command;
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  io.result?.({ gate: command, file: CONFIG_FILE });
  io.say(`set the project gate to ${command}`);
  io.say(`Next: commit ${CONFIG_FILE}, then run pullboard gate.`);
  return 0;
}
