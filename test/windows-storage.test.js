/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/windows-private-storage.js src/windows-shell.js src/windows-child-process.js src/relay-machine.js src/relay.js src/shell-run.js */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from '../src/windows-child-process.js';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { hasPrivatePermissions } from '../src/windows-private-storage.js';
import { commandShell } from '../src/windows-shell.js';

const windows = process.platform === 'win32';
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const installed = process.env.PULLBOARD_PACKAGE_ROOT || fileURLToPath(new URL('..', import.meta.url));

test(
  'native Git shell preserves quoting, Windows Node and failure status [A8]',
  { skip: !windows },
  () => {
    const result = spawnSync("node -p 'process.platform' && printf '%s' 'a b'", {
      shell: commandShell(),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replaceAll('\r', '').trim(), 'win32\na b');
    const failure = spawnSync('exit 7', { shell: commandShell(), windowsHide: true });
    assert.equal(failure.status, 7);
  },
);

test('installed Pullboard shell runner executes POSIX syntax natively [A8]', { skip: !windows }, () => {
  const module = pathToFileURL(join(installed, 'src', 'shell-run.js')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runShell } from ${JSON.stringify(module)}; const result = runShell(process.cwd(), "printf '%s' 'a b'", { pipefail: true }); console.log(result.output); process.exitCode = result.isGreen ? 0 : 1;`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'a b');
});

/** Isolate synthetic ACL fixtures and remove only the directory this test created. */
function temporary(work) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-windows-test-'));
  try {
    return work(root);
  } finally {
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + sep) &&
        basename(root).startsWith('pullboard-windows-test-'),
    );
    rmSync(root, { recursive: true, force: true });
  }
}

/** Set explicit synthetic NTFS grants without reading real credentials. */
function acl(path, extra = '') {
  const literal = path.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = '${literal}'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = (Get-Item -LiteralPath $path).PSIsContainer
$acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($directory) { 'ContainerInherit, ObjectInherit' } else { 'None' }
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
${extra}
if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
`;
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
}

/** Build a private machine record, optionally granting public read to prove refusal. */
function machine(root, insecure = false) {
  acl(root);
  const directory = join(root, 'relay-machine');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'state.json'),
    JSON.stringify({
      v: 2,
      autoLink: false,
      owner: null,
      machine: 'test-machine',
      devices: [],
      excluded: [],
      pending: null,
      revocations: [],
      approvals: [],
    }),
  );
  if (insecure)
    acl(
      directory,
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))",
    );
  return directory;
}

/** Exercise the actual machine reader against a synthetic private home. */
function readMachine(root) {
  const module = pathToFileURL(join(installed, 'src', 'relay-machine.js')).href;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readRelayMachine } from ${JSON.stringify(module)}; try { const state = readRelayMachine(); console.log(state.machine); } catch (error) { console.error(error.code); process.exitCode = 1; }`,
    ],
    {
      env: { ...process.env, PULLBOARD_HOME: root },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

/** Exercise the actual credential writer with a synthetic noncredential value. */
function saveLink(root) {
  const module = pathToFileURL(join(installed, 'src', 'relay.js')).href;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { saveLink } from ${JSON.stringify(module)}; import { join } from 'node:path'; try { saveLink(join(process.env.PULLBOARD_HOME, 'relay.json'), { token: 'synthetic-test-data' }); console.log('written'); } catch (error) { console.error(error.code); process.exitCode = 1; }`,
    ],
    {
      env: { ...process.env, PULLBOARD_HOME: root },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

test(
  'installed Pullboard refuses credential creation under a public parent [A8]',
  { skip: !windows },
  () =>
    temporary((root) => {
      acl(
        root,
        "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))",
      );
      const result = saveLink(root);
      assert.equal(result.status, 1, 'public-parent write must fail before creating a file');
      assert.match(result.stderr, /WINDOWS_PRIVATE_STORAGE/);
      assert.equal(existsSync(join(root, 'relay.json')), false);
    }),
);

test('installed Pullboard writes link metadata under a private parent [A8]', { skip: !windows }, () =>
  temporary((root) => {
    acl(root);
    const result = saveLink(root);
    assert.equal(result.status, 0, result.stderr);
    const file = join(root, 'relay.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'synthetic-test-data');
    assert.equal(hasPrivatePermissions(file, lstatSync(file)), true);
  }),
);

test('installed Pullboard reads secure native Windows machine storage [A8]', { skip: !windows }, () =>
  temporary((root) => {
    machine(root);
    const result = readMachine(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'test-machine');
  }),
);

test('installed Pullboard rejects public access to machine storage [A8]', { skip: !windows }, () =>
  temporary((root) => {
    machine(root, true);
    const result = readMachine(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELAY_MACHINE_STORAGE/);
  }),
);

test(
  'ACL validation accepts private files and rejects broader and inherited access [A8]',
  { skip: !windows },
  () =>
    temporary((root) => {
      acl(root);
      const file = join(root, "quoted ' path.txt");
      writeFileSync(file, 'synthetic');
      assert.equal(hasPrivatePermissions(file, lstatSync(file)), true);
      acl(
        root,
        "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))",
      );
      assert.equal(hasPrivatePermissions(root, lstatSync(root)), false);
      assert.equal(hasPrivatePermissions(file, lstatSync(file)), false);
    }),
);

test(
  'ACL validation accepts SYSTEM and Administrators and fails closed on missing paths [A8]',
  { skip: !windows },
  () =>
    temporary((root) => {
      acl(
        root,
        "foreach ($trusted in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($trusted), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')) }",
      );
      assert.equal(hasPrivatePermissions(root, lstatSync(root)), true);
      assert.equal(hasPrivatePermissions(join(root, 'missing'), lstatSync(root)), false);
    }),
);

test('ACL validation rejects directory junctions [A8]', { skip: !windows }, () =>
  temporary((root) => {
    acl(root);
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    assert.equal(hasPrivatePermissions(link, lstatSync(link)), false);
  }),
);
