/** Stable parent identities recorded at join, from an explicit declaration or this runtime's own session metadata [V1,B3]. */
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Refused } from "../../../kernel/index.js";
import { createHash } from 'node:crypto';
import { AGENT_SESSION_IDS } from "../../../kernel/index.js";
import { PARENT_SESSION_ENGINE } from "../../../state/light.js";
import { FAMILY_DECLARE_ENGINE } from "../../../state/light.js";
import { derivedFamily } from "./declaration.js";
import { recordFamily } from "./declaration.js";
import { invalidateUnknownFamilies } from "./declaration.js";
import { familyAliasesOf } from "../../light.js";
import { familyName } from "../../light.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import {
  saveAgentParent,
  saveAgentSession,
} from "../../../seats/index.js";
import { storeName } from './store-names.js';

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

/**
 * Save canonical ordered identities, or normalize direct API declarations, under their feature engine. For a rejoin,
 * true when the seat's family is already declared and final; for a new seat (`inserting`), true when its join event
 * records the family it registered, which the declaration engine does.
 */
export function saveJoinedSession(board, id, { parent, session, parentDigest, sessionDigest, family, inserting = false }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PARENT_SESSION_ENGINE) return;
  const recordedParent = parentDigest != null ? canonicalSessionDigest(parentDigest) : parent != null ? parentSessionDigest(parent) : null;
  const recordedSession = sessionDigest != null ? canonicalSessionDigest(sessionDigest) : session != null ? parentSessionDigest(session) : null;
  const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= FAMILY_DECLARE_ENGINE;
  const naming = typeof family === 'string' && family.trim() !== '' && modern;
  // The one derived family of this seat and its original session, leaving out a seat row this move just inserted.
  const declared = modern ? derivedFamily(board, id, { session: recordedSession, inserting }) : null;
  // A derived family is final for the seat and every seat of its session: another vendor is refused, another spelling of the same vendor is the same declaration, and a cleared (null) family changes nothing.
  if (naming && declared && familyName(family, familyAliasesOf(board)) !== familyName(declared, familyAliasesOf(board))) {
    throw new Refused('FAMILY_DECLARED', `${id} or its original session already declared vendor family ${declared}; a declared family is never changed`);
  }
  const first = naming && !declared;
  // The join is where a seat's family is recorded once: the family it already had, or the one this join declares.
  if (modern) recordFamily(board, id, declared ?? (first ? family : null));
  if (first) {
    // A seat with no declared family declares it once from its own worktree, whatever session joins; its recorded session stays as it was.
    board.db.exec('SAVEPOINT declare_family');
    try {
      if (recordedParent) saveAgentParent(board, id, recordedParent);
      if (recordedSession) saveAgentSession(board, id, recordedSession);
      for (const peer of invalidateUnknownFamilies(board, recordedSession)) recordFamily(board, peer, family);
      board.db.exec('RELEASE declare_family');
    } catch (error) {
      board.db.exec('ROLLBACK TO declare_family');
      board.db.exec('RELEASE declare_family');
      if (error.code !== 'PARENT_SESSION_CHANGED') throw error;
    }
    return inserting ? modern : false;
  }
  if (recordedParent) saveAgentParent(board, id, recordedParent);
  if (recordedSession) saveAgentSession(board, id, recordedSession);
  return inserting ? modern : Boolean(declared);
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
    if (!entry.isFile() || !entry.name.endsWith(`-${storeName(session, '.jsonl')}`)) continue;
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
