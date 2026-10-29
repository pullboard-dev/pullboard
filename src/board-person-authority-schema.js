/** Exact local authority declarations shared by normal pinning and bounded legacy recovery [E22,H16]. */
export const AUTHORITY = 'person_authority_local';

/** Triggers that keep the pinned relay key from being changed, removed or replaced through SQLite. */
export const AUTHORITY_TRIGGERS = [
  ['person_authority_update', `BEFORE UPDATE ON board_meta WHEN OLD.meta_key = '${AUTHORITY}'`],
  ['person_authority_delete', `BEFORE DELETE ON board_meta WHEN OLD.meta_key = '${AUTHORITY}'`],
  ['person_authority_replace', `BEFORE INSERT ON board_meta WHEN NEW.meta_key = '${AUTHORITY}' AND EXISTS (SELECT 1 FROM board_meta WHERE meta_key = '${AUTHORITY}')`],
].map(([name, on]) => ({ name, sql: `CREATE TRIGGER IF NOT EXISTS ${name} ${on}\nBEGIN SELECT RAISE(ABORT, 'PERSON_AUTHORITY: the pinned relay key is kept for good'); END` }));

