# _quarantine/

Files moved out of the active source tree but preserved per Golden Rule
(no deletions). Reasons documented below.

## Contents

### `src/main/main (# Name clash 2026-03-29 sqyss1C #).js`
OneDrive sync-collision artifact from 2026-03-29. Duplicate of
`src/main/main.js` from a moment when cloud sync resolved a parallel
edit. Not referenced by package.json `main` entry. Not loaded by Electron.
Quarantined 2026-05-19 to prevent it shipping in the v1.5.8 installer
(DIRECTIVE_COMPANION_BUILD_HYGIENE_CLEANUP_2026-05-19).

### `src/renderer/dashboard (# Name clash 2026-03-30 yadgu5C #).html`
OneDrive sync-collision artifact from 2026-03-30. Duplicate of
`src/renderer/dashboard.html` from cloud-sync collision. Not referenced
by any HTML loader path. Quarantined 2026-05-19 (same directive).
