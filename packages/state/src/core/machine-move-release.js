import { IN_STATE } from './machine-shared.js';

/**
 * The `release` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; src/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../shell/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'release', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    // Exit handoff appends its summary through the ordinary fact guards in this atomic release.
    alsoRefuses: [
      { code: 'S10', rule: 'a per-item criterion never requires the full suite or CI to pass', next: 'remove the full-suite or CI sentence from the criterion: pullboard edit <id> --criterion "<per-item outcome>"' },
      { code: 'DIAGNOSIS_WRONG', rule: 'a wrong-diagnosis release names what was wrong and returns a diagnosed claim the caller holds', next: 'claim the diagnosed item, then release it with --reason DIAGNOSIS_WRONG --note "<what was wrong>"' },
      { code: 'BAD_DEPENDENCIES', rule: 'release dependency ids are valid local item identifiers before the release is recorded', next: 'pass one or more existing local item ids with --on, or omit --on' },
      { code: "EXIT_CONTINUATION", rule: "an exit handoff retains a known native original session and honest declared family", next: "read the item summary, then continue from a fresh native session of its reserved model family" },
      { code: "EXIT_SUMMARY", rule: "an exit handoff carries nonempty Done, Failed and Next parts within the summary limit", next: "release with --reason OTHER --note \"Done: <work>; Failed: <case or none>; Next: <next step>\" to record the handoff atomically" },
      { code: "EMPTY_FACT", rule: "the atomic handoff summary is nonempty fact text", next: "give nonempty fact text: pullboard fact <id> note \"<what you saw>\"" },
      { code: "FACT_JUDGEMENT", rule: "the canonical fact writer restricts judgement and supersession to an authorized live holder or coordinator", next: "use a nonjudgement fact kind such as note, or ask the coordinator to record a judgement: pullboard fact <id> note \"<what you observed>\"" },
      { code: "BAD_FACT_ID", rule: "the canonical handoff fact identity is valid and has not already been published", next: "upgrade to the current Pullboard engine, then retry the original fact operation" },
      { code: "NO_FACT", rule: "the canonical fact writer resolves any referenced existing fact on this item", next: "name a fact id from pullboard show <id> --json" },
      { code: "FACT_INDEX_NOT_READY", rule: "the native fact identity indexes are available before recording the handoff", next: "have the owning main checkout open this board once, then retry the original fact operation" },
      { code: "BAD_FACT_KIND", rule: "the canonical fact writer recognizes the handoff fact kind", next: "use a supported kind, such as note: pullboard fact <id> note \"<what you observed>\"" },
      { code: "BAR_PARENT_UNKNOWN", rule: "canonical bar evidence retains known native parent attribution", next: "join a fresh worktree from the current native session with its real parent; an outside session must sign a bar whose author identities are known" },
      { code: "BAR_SELF_SIGN", rule: "canonical bar evidence requires an independent parent signer", next: "ask a different parent session to review the current bar and run pullboard bar sign <id> --note \"...\"" },
      { code: "BAD_FACT_REF", rule: "canonical fact references use the supported source and commit grammar", next: "cite code as path:line[-line]@<full 40-character commit>, from git rev-parse HEAD" },
      { code: "RIGOR_PERSON_ONLY", rule: "person-only rigor facts remain restricted to the person", next: "ask the person to mark it from the main checkout: pullboard fact <id> root-cause \"<why>\" --cause <key> --never-again --as person" },
      { code: "B26_PERSON_CHANNEL", rule: "person-only fact authority requires the native person channel", next: "record it as the person through pullboard view or the person's own terminal" },
      { code: "BAD_CAUSE", rule: "canonical fact causes use the supported structured cause grammar", next: "name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out" },
      { code: "NO_POLICY", rule: "canonical fact implications read an available committed coordinator policy", next: "restore and commit pullboard.json, then run the command again" },
      { code: "A5_GRAMMAR_VERSION", rule: "canonical fact implications use the supported committed spec grammar", next: "upgrade Pullboard: npm install -g pullboard@latest" },
    ],
    guards: ['joined', 'itemExists', IN_STATE, 'releaseOwnsWork', 'reviewReleaseExplained'], command: 'pullboard release <id> --reason <code>',
  },
];
