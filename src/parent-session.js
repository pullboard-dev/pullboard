/** Stable parent identities recorded at join, from an explicit declaration or this runtime's own session metadata [V1,B3]. */
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Refused } from './refused.js';
import { createHash } from 'node:crypto';
import { AGENT_SESSION_IDS } from '../packages/kernel/src/core/discovery.js';
import { PARENT_SESSION_ENGINE } from './parent-session-engine.js';
import { FAMILY_DECLARE_ENGINE } from './family-declare-engine.js';
import { declaredFamily } from './family-declaration.js';
import { saveFamilyWitness } from './family-declaration.js';
import { originalSession } from './family-declaration.js';
import { sessionDeclaredFamily } from './family-declaration.js';
import { saveSessionWitness } from './family-declaration.js';
import { familyAliasesOf } from './review-policy.js';
import { familyName } from './review-policy.js';
import { ENGINE_VERSION } from './machine.js';
import {
  saveAgentParent,
  saveAgentSession,
} from './seats.js';

/** Accept an opaque identity, never a path, whitespace, credential or arbitrary session metadata. */
export function parentIdentity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Refused('BAD_PARENT', 'a parent session is a stable id of at most 128 letters, numbers, dots, colons, underscores or hyphens; join again with --parent <session-id>');
  }
  return value;
}

/** Use one digest domain for explicit parents, discovered parents and a root's own session identity. */
export function parentSessionDigest(value) {
  return createHash('sha256').update(JSON.stringify(['parent-session', parentIdentity(value)])).digest('hex');
}

/** Validate canonical identities received in ordered registration, without rehashing them. */
export function canonicalSessionDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Refused('BAD_PARENT', 'the recorded parent session digest is invalid; join again from the runtime session');
  return value;
}

/** Save canonical ordered identities, or normalize direct API declarations, under their feature engine; true when the seat's family is already declared and final. */
export function saveJoinedSession(board, id, { parent, session, parentDigest, sessionDigest, family }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PARENT_SESSION_ENGINE) return;
  const recordedParent = parentDigest != null ? canonicalSessionDigest(parentDigest) : parent != null ? parentSessionDigest(parent) : null;
  const recordedSession = sessionDigest != null ? canonicalSessionDigest(sessionDigest) : session != null ? parentSessionDigest(session) : null;
  const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= FAMILY_DECLARE_ENGINE;
  const naming = typeof family === 'string' && family.trim() !== '' && modern;
  // Declared means ever declared: the recorded first declaration, the current family or any recorded family event.
  const original = modern ? originalSession(board, id, recordedSession) : null;
  // A family is declared for a seat and for its original session: another seat of that session inherits it.
  const bySession = modern ? sessionDeclaredFamily(board, original, id) : null;
  const current = modern ? board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(id)?.agent_family : null;
  const differs = (left, right) => familyName(left, familyAliasesOf(board)) !== familyName(right, familyAliasesOf(board));
  const claimed = naming ? family : typeof current === 'string' && current.trim() ? current : null;
  if (bySession && claimed && differs(claimed, bySession)) {
    throw new Refused('FAMILY_DECLARED', `${id}'s original session already declared vendor family ${bySession}; a declared family is never changed, in any seat of that session`);
  }
  if (bySession && !claimed) board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(bySession, id);
  const declared = modern ? declaredFamily(board, id) : null;
  // A declared family is final in every session: another vendor is refused, another spelling of the same vendor is the same declaration, and a cleared (null) family changes nothing.
  if (naming && declared && differs(family, declared)) {
    throw new Refused('FAMILY_DECLARED', `${id} already declared vendor family ${declared}; a declared family is never changed`);
  }
  if (declared) { saveFamilyWitness(board, id, declared); saveSessionWitness(board, original, declared); }
  const first = naming && !declared;
  if (first) {
    saveFamilyWitness(board, id, family);
    saveSessionWitness(board, original, family);
    // A seat with no declared family declares it once from its own worktree, whatever session joins; its recorded session stays as it was.
    board.db.exec('SAVEPOINT declare_family');
    try {
      if (recordedParent) saveAgentParent(board, id, recordedParent);
      if (recordedSession) saveAgentSession(board, id, recordedSession);
      board.db.exec('RELEASE declare_family');
    } catch (error) {
      board.db.exec('ROLLBACK TO declare_family');
      board.db.exec('RELEASE declare_family');
      if (error.code !== 'PARENT_SESSION_CHANGED') throw error;
    }
    return false;
  }
  if (recordedParent) saveAgentParent(board, id, recordedParent);
  if (recordedSession) saveAgentSession(board, id, recordedSession);
  return Boolean(declared);
}

/** Read only the bounded first record; conversation history and other sessions' contents are never opened. */
function ownSessionMetadata(file, session) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, count).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return null;
    const record = JSON.parse(text.slice(0, end));
    if (record.type !== 'session_meta' || ![record.payload?.id, record.payload?.session_id].includes(session)) return null;
    return record.payload;
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Keep the runtime's own identity; discover a parent only in its matching Codex metadata record. */
export function runtimeSessionIdentity(environment = process.env, home = homedir()) {
  const key = AGENT_SESSION_IDS.find(name => Boolean(environment[name]));
  if (!key) return null;
  let session;
  try { session = parentIdentity(environment[key]); }
  catch { return null; }
  const own = { session, parent: null };
  if (key === 'CLAUDE_CODE_SESSION_ID') return own;
  const sessions = join(environment.CODEX_HOME || join(home, '.codex'), 'sessions');
  let entries;
  try { entries = readdirSync(sessions, { recursive: true, withFileTypes: true }); }
  catch { return own; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(`-${session}.jsonl`)) continue;
    const metadata = ownSessionMetadata(join(entry.parentPath, entry.name), session);
    if (!metadata) continue;
    const parent = metadata.parent_thread_id ?? metadata.source?.subagent?.thread_spawn?.parent_thread_id;
    try { return { session: parentIdentity(session), parent: parent ? parentIdentity(parent) : null }; }
    catch { /* An invalid runtime record cannot declare another identity. */ }
  }
  return own;
}

/** Read this runtime's parent, keeping a primary session's missing parent visible as unknown. */
export function runtimeParentSession(environment = process.env, home = homedir()) {
  return runtimeSessionIdentity(environment, home)?.parent ?? null;
}

/** An explicit declaration and the runtime record use exactly the same canonical identity. */
export function joinParentSession(declared, environment = process.env) {
  return declared === undefined ? runtimeParentSession(environment) : parentIdentity(declared);
}
