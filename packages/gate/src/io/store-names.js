/** The gate cell's store file names [C7,CD2]: a store file named by its key is built here, so no site holds a stemless `${key}.json` template. */

/** The extension of every keyed JSON store file the gate keeps. */
export const STORE_EXT = '.json';

/** The file name of one keyed record (a receipt id, a test key, a content digest) in its store folder. */
export function storeName(key) {
  return key + STORE_EXT;
}
