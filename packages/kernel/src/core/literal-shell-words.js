/** Read literal shell words without interpreting expansions or operators. */
/** Split a literal shell command into words, refusing expansion, operators, and incomplete quoting. */
export function literalShellWords(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const words = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of command) {
    if (character === '\n' || character === '\r') return null;
    if (quote === "'") {
      if (character === "'") quote = '';
      else word += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = '';
      else if ('$`\\'.includes(character)) return null;
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (';&|<>$`(){}*?[]\\'.includes(character)) return null;
    word += character;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

