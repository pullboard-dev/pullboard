import { IN_STATE } from './machine-shared.js';

/**
 * The `release` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('./machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'release', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    // Exit handoff appends its summary through the ordinary fact guards in this atomic release.
    alsoRefuses: [
      { code: "EXIT_CONTINUATION", next: "read the item summary, then continue from a fresh native session of its reserved model family" },
      { code: "EXIT_SUMMARY", next: "release with --note \"Done: <work>; Failed: <case or none>; Next: <next step>\" to record the handoff atomically" },
      { code: "EMPTY_FACT", next: "give nonempty fact text: pullboard fact <id> note \"<what you saw>\"" },
      { code: "FACT_JUDGEMENT", next: "use a nonjudgement fact kind such as note, or ask the coordinator to record a judgement: pullboard fact <id> note \"<what you observed>\"" },
      { code: "BAD_FACT_ID", next: "upgrade to the current Pullboard engine, then retry the original fact operation" },
      { code: "NO_FACT", next: "name a fact id from pullboard show <id> --json" },
      { code: "FACT_INDEX_NOT_READY", next: "have the owning main checkout open this board once, then retry the original fact operation" },
      { code: "BAD_FACT_KIND", next: "use a supported kind, such as note: pullboard fact <id> note \"<what you observed>\"" },
      { code: "BAR_PARENT_UNKNOWN", next: "join a fresh worktree from the current native session with its real parent; an outside session must sign a bar whose author identities are known" },
      { code: "BAR_SELF_SIGN", next: "ask a different parent session to review the current bar and run pullboard bar sign <id> --note \"...\"" },
      { code: "BAD_FACT_REF", next: "cite code as path:line[-line]@<full 40-character commit>, from git rev-parse HEAD" },
      { code: "RIGOR_PERSON_ONLY", next: "ask the person to mark it from the main checkout: pullboard fact <id> root-cause \"<why>\" --cause <key> --never-again --as person" },
      { code: "B26_PERSON_CHANNEL", next: "record it as the person through pullboard view or the person's own terminal" },
      { code: "BAD_CAUSE", next: "name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out" },
      { code: "NO_POLICY", next: "restore and commit pullboard.json, then run the command again" },
      { code: "A5_GRAMMAR_VERSION", next: "upgrade Pullboard: npm install -g pullboard@latest" },
    ],
    guards: ['joined', 'itemExists', IN_STATE, 'releaseOwnsWork', 'reviewReleaseExplained'], command: 'pullboard release <id>',
  },
];
