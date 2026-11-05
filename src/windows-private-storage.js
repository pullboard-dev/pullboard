import { spawnSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Reject inherited public access before any sensitive bytes reach disk. */
export function writePrivateFileSync(Refusal, path, ...args) {
  if (process.platform === 'win32' && typeof path !== 'number') {
    const parent = dirname(path);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivatePermissions(parent, stat)) {
      throw new Refusal(
        'WINDOWS_PRIVATE_STORAGE',
        'Restore current-user-only NTFS permissions on the storage directory before writing private Pullboard data.',
      );
    }
  }
  return writeFileSync(path, ...args);
}

/** Check NTFS rather than Node's synthetic Unix mode bits on Windows. */
export function hasPrivatePermissions(path, stat) {
  if (process.platform !== 'win32') return (stat.mode & 0o077) === 0;
  const literal = path.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $path = '${literal}'
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
  $acl = Get-Acl -LiteralPath $path
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 1 }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  if ($null -eq $raw.DiscretionaryAcl) { exit 1 }
  $ownerAccess = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      $principal = $rule.IdentityReference.Value
      if ($principal -notin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { exit 1 }
      if ($principal -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)) {
        $ownerAccess = $true
      }
    }
  }
  if (-not $ownerAccess) { exit 1 }
  exit 0
} catch { exit 1 }
`;
  const result = spawnSync(
    join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: 'ignore', timeout: 10000 },
  );
  return !result.error && result.status === 0;
}
