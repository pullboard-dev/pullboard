# Resume release notes

## Resume release notes

<!-- resume-release-notes:start -->
`pullboard resume --json` adds a `whatsNew` field to its version-1 envelope. `whatsNew` is `null` when nothing is new. After an upgrade it contains the released versions newer than this checkout last ran, newest first:

```json
{
  "whatsNew": {
    "releases": [
      {
        "version": "0.8.7",
        "headline": "A new session",
        "paragraph": "Release headline paragraph."
      }
    ],
    "omitted": 0,
    "notes": "CHANGELOG.md"
  }
}
```

Each `releases` entry has a version number, the release headline from its `###` heading in `CHANGELOG.md`, and that heading's paragraph. Added, Changed and Fixed lists are excluded. Only the newest three releases are included; `omitted` counts the earlier releases left out, and `notes` names the full release notes.

Both text and JSON resumes record the displayed version once per checkout. Later resumes at the same version have no extra text and a null `whatsNew` field. A checkout's first run records its version quietly. The record is `pullboard-checkout/resume-version` in the checkout's Git directory, outside the shared board; linked worktrees keep separate records. JSON resume includes the notes in its response when recording that version, so a JSON call does not consume notes without exposing them.
<!-- resume-release-notes:end -->
