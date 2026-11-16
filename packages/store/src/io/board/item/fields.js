/** Typed key/value fields on an item: a declaration table and a value table, behind items.typedFields (#9350, #1321) [C7]. */
import { atomic } from '../event/log.js';
import { Refused } from '../../../../../kernel/index.js';

/** The field types a declaration may name. */
export const FIELD_TYPES = Object.freeze(['text', 'choice', 'number']);

/**
 * The two field tables, made on first use instead of in the board schema.
 * Why: with the setting off no board gains a table, so the schema digest and every existing reader stay as they were.
 */
export const FIELD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS field_decl (
    field_name TEXT PRIMARY KEY,
    field_type TEXT NOT NULL,
    field_choices TEXT NOT NULL DEFAULT '[]',
    field_declared_by TEXT NOT NULL,
    field_declared_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS item_field (
    item_id INTEGER NOT NULL REFERENCES item (item_id),
    field_name TEXT NOT NULL REFERENCES field_decl (field_name),
    field_value TEXT NOT NULL,
    field_set_by TEXT NOT NULL,
    field_set_at TEXT NOT NULL,
    PRIMARY KEY (item_id, field_name)
  );
`;

/**
 * Refuse while items.typedFields is off, so the default board gains nothing.
 * Why a port: the store takes no config import, so the caller reads the setting and passes `enabled`.
 */
function requireEnabled(enabled) {
  if (enabled !== true) throw new Refused('FIELDS_OFF', 'typed item fields are off; turn on items.typedFields in the machine settings first');
}

/** True when the field tables exist on this board. */
function hasTables(db) {
  return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('field_decl','item_field')").get().n === 2;
}

/**
 * Declare a field of type text, choice or number; a choice field lists its allowed choices.
 * Why declared first: a value is judged against its declared type, so a wrong one is refused before anything is stored.
 *
 * @param {{ db: any }} board
 * @param {{ by: string, name: string, type: string, choices?: string[], enabled?: boolean }} call - `enabled` is items.typedFields, read by the caller.
 * @returns {{ name: string, type: string, choices: string[] }}
 */
export function declareItemField(board, { by, name, type, choices = [], enabled = false }) {
  requireEnabled(enabled);
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new Refused('FIELD_NAME', 'a field name is 1 to 32 lowercase letters, digits, _ or -, starting with a letter; pick one like "size"');
  if (!FIELD_TYPES.includes(type)) throw new Refused('FIELD_TYPE', `field type ${JSON.stringify(type)} is not one of ${FIELD_TYPES.join(', ')}; declare it as text, choice or number`);
  if (type === 'choice' && (!Array.isArray(choices) || choices.length === 0 || choices.some(choice => typeof choice !== 'string' || !choice))) throw new Refused('FIELD_TYPE', 'a choice field lists its choices as non-empty strings; pass at least one');
  if (type !== 'choice' && choices.length) throw new Refused('FIELD_TYPE', `a ${type} field takes no choices; drop them or declare a choice field`);
  return atomic(board, () => {
    board.db.exec(FIELD_SCHEMA_SQL);
    if (board.db.prepare('SELECT 1 FROM field_decl WHERE field_name=?').get(name)) throw new Refused('FIELD_DECLARED', `field ${name} is already declared; use another name`);
    board.db.prepare('INSERT INTO field_decl (field_name, field_type, field_choices, field_declared_by, field_declared_at) VALUES (?,?,?,?,?)')
      .run(name, type, JSON.stringify(choices), by, new Date().toISOString());
    return { name, type, choices };
  });
}

/** Judge a value against a declaration and return the text to store. */
function storedValue(decl, value) {
  if (decl.field_type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refused('FIELD_TYPE', `field ${decl.field_name} is a number; give a finite number, not ${JSON.stringify(value)}`);
    return String(value);
  }
  if (typeof value !== 'string') throw new Refused('FIELD_TYPE', `field ${decl.field_name} is ${decl.field_type}; give a string, not ${JSON.stringify(value)}`);
  if (decl.field_type === 'choice' && !JSON.parse(decl.field_choices).includes(value)) {
    throw new Refused('FIELD_TYPE', `field ${decl.field_name} is a choice; use one of ${JSON.parse(decl.field_choices).join(', ')}, not ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Set an item's value for a declared field. A value of the wrong type is refused with FIELD_TYPE and nothing is stored.
 *
 * @param {{ db: any }} board
 * @param {{ by: string, id: number, name: string, value: string | number, enabled?: boolean }} call
 */
export function setItemField(board, { by, id, name, value, enabled = false }) {
  requireEnabled(enabled);
  return atomic(board, () => {
    if (!hasTables(board.db)) throw new Refused('FIELD_UNDECLARED', `field ${name} is not declared; declare it first`);
    const decl = board.db.prepare('SELECT * FROM field_decl WHERE field_name=?').get(name);
    if (!decl) throw new Refused('FIELD_UNDECLARED', `field ${name} is not declared; declare it first`);
    if (!board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(id)) throw new Refused('NO_SUCH_ITEM', `item #${id} does not exist; check the id`);
    const text = storedValue(decl, value);
    board.db.prepare('INSERT OR REPLACE INTO item_field (item_id, field_name, field_value, field_set_by, field_set_at) VALUES (?,?,?,?,?)')
      .run(id, name, text, by, new Date().toISOString());
    return { id, name, type: decl.field_type, value };
  });
}

/**
 * An item's field values, each with its declared type: numbers read back as numbers.
 * Empty when the setting is off or the tables were never made, so a reader needs no guard.
 *
 * @param {{ db: any }} board
 * @param {number} id
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ name: string, type: string, value: string | number }[]}
 */
export function itemFields(board, id, { enabled = false } = {}) {
  if (enabled !== true || !hasTables(board.db)) return [];
  return board.db.prepare('SELECT f.field_name AS name, d.field_type AS type, f.field_value AS value FROM item_field f JOIN field_decl d ON d.field_name=f.field_name WHERE f.item_id=? ORDER BY f.field_name').all(id)
    .map(row => ({ name: row.name, type: row.type, value: row.type === 'number' ? Number(row.value) : row.value }));
}
