/** Store file names [C7]: a record named by its key gets its name here, never from a stemless template. */
export const STORE_EXT = '.json';

/** The file name of the record held under `key`. */
export function storeName(key) { return key + STORE_EXT; }
