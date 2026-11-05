import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Pullboard emits POSIX syntax; Git for Windows supplies a native Windows shell. */
export function commandShell() {
  if (process.platform !== 'win32') return true;
  const executables = execFileSync('where.exe', ['git.exe'], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/);
  for (const executable of executables) {
    const directory = dirname(executable);
    const shell = [
      join(directory, '..', 'bin', 'bash.exe'),
      join(directory, 'bash.exe'),
      join(directory, '..', '..', 'usr', 'bin', 'bash.exe'),
    ]
      .map((path) => resolve(path))
      .find((path) => existsSync(path));
    if (shell) return shell;
  }
  throw new Error(
    'Pullboard needs Git for Windows with its bundled bash.exe to execute POSIX gate and formatter commands.',
  );
}
