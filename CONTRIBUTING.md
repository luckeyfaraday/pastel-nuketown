# Contributing to Pastel Nuketown

Thanks for wanting to make the game better. This document defines how changes get in. Follow the lane that matches your contribution so it can be reviewed quickly.

## Before you start

- Run `npm run check` on a clean checkout. If it fails, fix that first or report it as a bug.
- `index.html` is generated. Never edit it directly; edit files in `src/` and run `npm run build`.
- The game targets modern evergreen browsers (Chrome, Firefox, Edge, Safari). No build tooling beyond `build.sh` and Node >= 18.

## Bug reports

Use the [bug report issue template](.github/ISSUE_TEMPLATE/bug_report.yml).

A good bug report includes:

1. **Browser and OS** (e.g. Chrome 137 / Ubuntu 24.04).
2. **Steps to reproduce**, starting from the title screen.
3. **Expected vs actual behaviour**.
4. **Console output** (F12 > Console). Paste errors verbatim.
5. **Multiplayer context** if relevant: room size, number of players, whether you were host or client, approximate latency.

Netcode bugs are timing-sensitive. If the issue only appears in multiplayer, say so explicitly and note whether it reproduces with bots-only.

## Feature requests

Use the [feature request issue template](.github/ISSUE_TEMPLATE/feature_request.yml).

A good feature request includes:

1. **Gameplay rationale** — why is this fun? What moment does it create?
2. **Scope estimate** — does it touch client-only code, the server, or the wire protocol?
3. **Alternatives considered** — is there a simpler way to get the same feeling?

Feature requests that amount to "add X from another game" without a rationale will be closed. We are selective about scope: the game is a small FFA arena shooter, and staying small is a feature.

### Current scope boundaries

These are out of scope unless discussed with a maintainer first:

- Team-based or objective game modes (the game is FFA by design)
- New weapons (the three-weapon set is intentionally tight)
- Persistence, accounts, or progression systems
- Anything that requires a database

If your idea falls in one of these buckets, open an issue anyway to discuss it, but do not start implementation before getting a go-ahead.

## Pull requests

### Ground rules

- One concern per PR. Do not bundle a bug fix with a refactor.
- Run `npm run check` before pushing. CI will reject stale builds and failing tests.
- No new dependencies without prior discussion. The dependency footprint is intentionally one package (`ws`).
- Follow the existing code style: no comments unless explaining a non-obvious "why", UMD wrappers for shared modules, numbered file prefixes in `src/`.

### What to include

- A clear description of what the PR does and why.
- Link to the issue it addresses (`Fixes #42`).
- For gameplay changes: a short description of how it feels in play.
- For visual changes: screenshots or a short clip.

### Review process

- A maintainer reviews every PR.
- Gameplay-affecting changes (weapon stats, movement, bot behaviour) get playtested before merge, not just code-reviewed.
- Expect at least one round of feedback. This is normal.

## Protocol changes (net-protocol.js)

`net-protocol.js` is a **shared contract** between the client, the server, and the test suite. Changing it can break every connected player.

Rules:

1. **Open an RFC-style issue first.** Describe the change, why it is needed, and what breaks if old and new versions talk to each other.
2. **Bump `VERSION`** if the change is not backwards-compatible.
3. **Update both sides** (client in `src/75-network.js` and server in `server.mjs`) in the same PR.
4. **Add or update tests** in `net-protocol.test.js` covering the new or changed messages.
5. Protocol PRs without a prior issue will be closed.

The same applies to `mapspec.js` — it is consumed by the renderer, the physics engine, and the bot navigation. Structural changes need discussion first.

## File placement

New client code goes in `src/` with the correct numbered prefix so `build.sh` picks it up in dependency order:

| Range | Layer |
|---|---|
| 00–09 | HTML (head, body) |
| 10–19 | Core utilities |
| 20–29 | World / scene |
| 30–39 | Physics |
| 40–49 | Weapons |
| 50–59 | Actors / characters |
| 60–69 | Effects |
| 70–79 | Game logic / network |
| 80–89 | UI |
| 90–99 | Boot / main loop |

If you add a new file, also add it to the `build.sh` concatenation list and to the `npm run check` syntax-check command in `package.json`.

## Art and assets

The visual identity is a soft pastel palette. The canonical colours are the CSS custom properties in `src/00-head.html`:

```
--pink:#ffb7c5  --peach:#ffd3b6  --butter:#ffefa8
--mint:#b8f2d8  --sky:#a8dcf0    --lilac:#d4c5f9
--coral:#ff9aa2 --ink:#4a3f5c    --cream:#fff8f0
```

New assets should stay within this palette. Weapon viewmodels use the `col` fields in `src/40-weapons.js` as reference.

## Questions

Open a plain issue (no template) with the `question` label, or reach out to a maintainer before investing time in something that might not fit.
