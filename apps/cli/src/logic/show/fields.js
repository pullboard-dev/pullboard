/** The typed fields and related links lines `pullboard show` prints, kept pure so show.js prints through one function [C7,#9352]. */

/**
 * The fields block then the related links block, each only when it has entries.
 *
 * @param {{ name: string, type: string, value: unknown }[]} fields the item typed fields
 * @param {{ id: number | string, title: string }[]} links the item related links
 * @returns {string[]} the lines in print order; empty when both lists are empty
 */
export function fieldLines(fields, links) {
  return [
    ...(fields.length ? ["fields:", ...fields.map((field) => `  ${field.name} (${field.type}): ${field.value}`)] : []),
    ...(links.length ? ["related links:", ...links.map((link) => `  #${link.id} ${link.title}`)] : []),
  ];
}
