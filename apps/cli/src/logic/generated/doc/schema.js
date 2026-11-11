/** Describe the real initialized SQLite schema, including connection-local guards [C7,A5]. */
import { docTable } from './blocks.js';

/** Quote a SQLite identifier, including names containing a quote. */
function identifier(name) { return `"${name.replaceAll('"', '""')}"`; }

/** Render live columns with the same key, default and reference facts SQLite enforces. */
function columns(db, schema) {
  const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return docTable(['Table', 'Column', 'Type', 'Rules'], tables.flatMap(({ name }) => {
    const refs = db.prepare(`PRAGMA ${schema}.foreign_key_list(${identifier(name)})`).all();
    const unique = db.prepare(`PRAGMA ${schema}.index_list(${identifier(name)})`).all()
      .filter(index => index.unique && index.origin !== 'pk')
      .flatMap(index => db.prepare(`PRAGMA ${schema}.index_info(${identifier(index.name)})`).all()).map(column => column.name);
    return db.prepare(`PRAGMA ${schema}.table_info(${identifier(name)})`).all().map(column => {
      const rules = [column.pk ? 'PRIMARY KEY' : column.notnull ? 'NOT NULL' : 'nullable'];
      if (column.dflt_value !== null) rules.push(`DEFAULT ${column.dflt_value}`);
      if (unique.includes(column.name)) rules.push('UNIQUE');
      for (const ref of refs.filter(ref => ref.from === column.name)) rules.push(`REFERENCES ${ref.table}(${ref.to})`);
      return [`\`${name}\``, `\`${column.name}\``, `\`${column.type}\``, rules.map(rule => `\`${rule}\``).join('; ')];
    });
  }));
}

/** Render actual persistent or connection-local trigger identities. */
function triggers(db, schema) {
  return docTable(['Trigger', 'Table'], db.prepare(`SELECT name,tbl_name FROM ${schema}.sqlite_master WHERE type='trigger' ORDER BY name`)
    .all().map(row => [`\`${row.name}\``, `\`${row.tbl_name}\``]));
}

/** Collect every schema table from the initialized connection; no persistent board is opened. */
export function schemaDocBlocks(db) {
  const indexes = db.prepare("SELECT name,tbl_name FROM main.sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return {
    'board-columns': columns(db, 'main'), 'temp-columns': columns(db, 'temp'),
    'board-triggers': triggers(db, 'main'), 'temp-triggers': triggers(db, 'temp'),
    'board-indexes': docTable(['Index', 'Table', 'Columns', 'Unique'], indexes.map(({ name, tbl_name }) => [
      `\`${name}\``, `\`${tbl_name}\``, db.prepare(`PRAGMA main.index_info(${identifier(name)})`).all()
        .map(column => `\`${column.name ?? '(expression)'}\``).join(', '),
      db.prepare(`PRAGMA main.index_list(${identifier(tbl_name)})`).all().find(index => index.name === name).unique ? 'yes' : 'no',
    ])),
  };
}
