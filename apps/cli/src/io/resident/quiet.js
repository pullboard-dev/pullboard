/** Drop node:sqlite's experimental notice before the modules that load it run; the in-process entry drops it too [H24]. */
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};
