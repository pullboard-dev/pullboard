/** Local SSH proofs checked against direct GitHub keys [E17]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  homedir,
  tmpdir,
} from 'node:os';
import { join } from 'node:path';
import { Refused } from './refused.js';

/** Run ssh-keygen in a private scratch folder, refusing plainly when OpenSSH is not installed. */
function sshKeygen(args, input) {
  const result = spawnSync('ssh-keygen', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  if (result.error?.code === 'ENOENT') throw new Refused('RELAY_SSH_KEYGEN', 'ssh-keygen is not installed; install OpenSSH, then run pullboard relay on again');
  return result;
}

/** Work with files in a fresh owner-only folder that is always removed. */
function scratch(work) {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-vouch-'));
  try { return work(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** The SSH key that vouches for this device: PULLBOARD_SSH_KEY, or the usual key files under ~/.ssh. */
function signingKey(environment = process.env) {
  if (environment.PULLBOARD_SSH_KEY) return environment.PULLBOARD_SSH_KEY;
  const found = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(name => join(homedir(), '.ssh', name)).find(existsSync);
  if (!found) throw new Refused('RELAY_SSH_KEY', 'no SSH key here vouches for this device; add one to your GitHub account with ssh-keygen -t ed25519 and gh ssh-key add, or set PULLBOARD_SSH_KEY to its path');
  return found;
}

/**
 * Sign the statement with the person's SSH key. With an agent running, the public half lets ssh-agent sign for a key
 * with a passphrase; otherwise ssh-keygen reads the private key file itself.
 */
export function signSshVouch(bytes, namespace, requestedKey) {
  const key = requestedKey ?? signingKey();
  return scratch(folder => {
    const file = join(folder, 'statement');
    writeFileSync(file, bytes, { mode: 0o600 });
    const tries = process.env.SSH_AUTH_SOCK && existsSync(key + '.pub') ? [key + '.pub', key] : [key];
    let failure = '';
    for (const signer of tries) {
      const result = sshKeygen(['-Y', 'sign', '-q', '-n', namespace, '-f', signer, file]);
      if (result.status === 0 && existsSync(file + '.sig')) return readFileSync(file + '.sig', 'utf8');
      failure = String(result.stderr ?? '').trim().split('\n')[0];
    }
    throw new Refused('RELAY_SSH_SIGN', `ssh-keygen could not sign with ${key}${failure ? ' (' + failure + ')' : ''}; load the key with ssh-add, or set PULLBOARD_SSH_KEY to a key on your GitHub account`);
  });
}

/** Whether one of the login's GitHub SSH keys made this signature over this exact statement. */
export async function verifySshVouch(bytes, signature, login, githubKeys, namespace) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(login) || typeof signature !== 'string' || signature.length > 16384 || !/^[a-z0-9-]+$/u.test(namespace)) return false;
  const keys = (await githubKeys(login)).filter(key => typeof key === 'string' && /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+$/u.test(key));
  if (!keys.length) return false;
  return scratch(folder => {
    writeFileSync(join(folder, 'allowed'), keys.map(key => `${login} namespaces="${namespace}" ${key}`).join('\n') + '\n', { mode: 0o600 });
    writeFileSync(join(folder, 'statement.sig'), signature, { mode: 0o600 });
    return sshKeygen(['-Y', 'verify', '-f', join(folder, 'allowed'), '-I', login, '-n', namespace, '-s', join(folder, 'statement.sig')], bytes).status === 0;
  });
}

