/** The name of the committed coordinator settings file: the one home of this literal, so light doors ask here instead of repeating it [CD2]. */
export const CONFIG_FILE = 'pullboard.json';

/** Whether a path or tree entry name is the coordinator settings file. */
export function isConfigFile(name) { return name === CONFIG_FILE; }
