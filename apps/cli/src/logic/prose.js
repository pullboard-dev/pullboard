/** The source-only prose oracle; browser chip behavior stays in the View suite [N26,C7]. */
/** Read the CLI command declaration without starting a page or evaluating user prose. */
export function declaredProseCommands(help) {
  const declared = new Set();
  const read = (text) => {
    // Usage alternatives may follow an argument or an optional group: spec approve <ids> | decline <ids>, and
    // spec fit [approve <batch>] | fit edit <row>, whose alternative restates the last word.
    for (const branch of text.matchAll(/pullboard ((?:[a-z-]+ )+)(?:<[^>]+> |\[[^\]]+\] )?\| ([a-z-]+(?: [a-z-]+)*)/g)) {
      const shared = branch[1].trim().split(' ').slice(0, -1);
      read('pullboard ' + [...shared, branch[2]].join(' '));
    }
    for (const found of text.matchAll(/(?:^|[\s(`'"])pullboard ((?:\S+ ?)+?)(?= {2}|$|[;,.)](?:\s|$))/gm)) {
      const tokens = found[1].trim().split(' ');
      const phrase = [];
      for (let n = 0; n < tokens.length; n++) {
        const token = tokens[n];
        if (/^[a-z][a-zA-Z-]*$/.test(token)) { phrase.push(token); continue; }
        const choices = /^\[?([a-z][a-zA-Z-]*(?:\|[a-z][a-zA-Z-]*)+)\]?$/.exec(token);
        if (choices) for (const choice of choices[1].split('|')) declared.add([...phrase, choice].join(' '));
        else if (token === '|' && phrase.length === 1) {
          for (let k = n + 1; k < tokens.length; k += 2) { if (!/^[a-z][a-zA-Z-]*$/.test(tokens[k])) break; declared.add(tokens[k]); if (tokens[k + 1] !== '|') break; }
        }
        break;
      }
      if (phrase.length) declared.add(phrase.join(' '));
    }
  };
  read(help.all);
  for (const name of Object.keys(help.commands)) declared.add(name);
  for (const row of Object.values(help.commands)) for (const usage of row.usages) read(usage);
  return declared;
}
