# Pastel Nuketown — Browser Multiplayer FPS Game

Pastel Nuketown is a free-to-play first-person shooter (FPS) game that runs entirely in the browser. Built with Three.js and vanilla JavaScript, it features a pastel-styled Nuketown-inspired arena with host-authoritative multiplayer over WebSockets. Play solo against AI bots or create a room for up to 9 players. No downloads, no plugins, no accounts — open the page and play.

![Pastel Nuketown title screen: a PLAY button over the pastel arena, with a room browser listing two joinable rooms and one marked IN PROGRESS](shots/title.png)

## Features

- **Browser-based FPS** — runs in any modern browser (Chrome, Firefox, Edge, Safari) with no install
- **One-button matchmaking** — PLAY joins the busiest room with a seat free, opens one when there is nothing to join, and starts the match on a countdown instead of waiting for someone to click
- **Drop-in join** — walk into a round already in progress; you spawn shielded and a bot gives up its slot, so nobody waits out somebody else's match
- **Plays on a phone** — on-screen thumbstick, look-drag and button cluster appear automatically on touch devices, with an analog stick the netcode carries as-is
- **Multiplayer rooms** — host-authoritative relay server supports up to 9 players per room with client-side interpolation and prediction
- **AI bots** — three difficulty levels (easy, normal, hard) with navigation mesh pathfinding, burst-fire combat, and retreat behaviour
- **Three weapons** — BUBBLEGUN (full-auto SMG), MARSHMALLOW (9-pellet shotgun), LOLLIPOP (semi-auto rifle with 2.2x headshot multiplier)
- **LAN play** — the relay accepts any origin by default, so players on a local network can join without configuration
- **Single-file build** — the entire client compiles to one `index.html` via a shell script; no bundler, no framework
- **First to 25 kills** — free-for-all match format with respawns, spawn shields, killfeed, and a live scoreboard

## Tech stack

| Layer | Technology |
|---|---|
| Rendering | [Three.js](https://threejs.org/) 0.128 (loaded from CDN, no local copy) |
| Client language | Vanilla JavaScript (ES2020+, no transpiler) |
| Networking | WebSocket via the [`ws`](https://github.com/websockets/ws) library |
| Server | Node.js >= 18.14 (ES modules, `node:http` + `ws`) |
| Multiplayer model | Host-authoritative relay with snapshot/event messages |
| Build | `build.sh` (concatenates numbered `src/` files into `index.html`) |
| Tests | Node.js built-in test runner (`node --test`) |
| Deployment | systemd + nginx + TLS on Ubuntu 24.04 (`deploy/provision.sh`) |

## Quick start

**Prerequisites:** Node.js >= 18.14 and npm.

```bash
npm install
npm start          # builds index.html, then starts the relay on port 8080
```

Open `http://localhost:8080` in a modern browser (set `PORT` to use another). Click the canvas to lock the pointer and start playing.

### How to play on LAN with friends

The WebSocket relay accepts any origin by default. Players on your local network can connect at `http://<your-ip>:8080` without any configuration. To restrict origins in production, set `ALLOWED_ORIGINS` in `deploy/provision.sh`.

## Matchmaking

**PLAY** is the whole flow for anyone who does not want to think about rooms. It reads the room browser, joins the room with the most players and a seat still free, and opens a room of its own only when there is nothing to join. Fullest-first on purpose: a thin population belongs in one match rather than scattered across four rooms of one.

Once a room holds two people it counts down and starts on its own — five seconds, and twelve between rounds so a scoreboard can be read. **START MATCH** is still there for the impatient, and a host saving a seat for a friend presses **HOLD**, which buys thirty more seconds and can be pressed twice.

The clock runs on the relay rather than in the host's page, which is the only version of it that works: the host who needs it most is the one who stopped looking at their page, and a browser nobody is looking at has had its timers throttled to a crawl or stopped outright. So the countdown you see is the relay's, sent with the roster and shown to guests as well as the host, and no player's inaction can hold a room shut. A host asleep at the start of its own round is elected away by the snapshot watchdog moments later and the room plays on without it.

![The room lobby showing a two-player roster, a COPY INVITE button, and a countdown reading "Starting in 11…" next to a HOLD button](shots/lobby.png)

The browser lists rooms in a live match as well as open ones, marked `IN PROGRESS` with a dashed edge and a **DROP IN** button. You can walk straight into a round already underway: the host seats you on a spawn point with the usual shield, a bot gives up its slot so the match does not quietly get busier, and the world arrives on the next snapshot. No waiting out somebody else's 25 kills.

A guest who stops playing for a minute during a match is removed and told why, so the seat goes back to somebody who wants it. "Playing" means moving, jumping, firing, reloading, switching weapon — or just looking around, since someone turning to watch a firefight is present. An idle client still sends input sixty times a second, so the relay judges what the input says rather than that it arrived. Lobbies are exempt, because waiting is what a lobby is for, and the host is exempt, because it is the simulation.

Drop-in needs no message of its own. The actor manifest is versioned and guests already accept it changing mid-round — the same machinery host migration uses — so seating an arrival is `netPruneDepartedPlayers` run backwards. The relay hands over no world state; it tells the arrival the round is live and tells the host the roster changed, and the host's next snapshot does the rest.

An invite link (`?room=CODE`, produced by **COPY INVITE**) joins that room on arrival rather than typing the code into the box for you. **ROOM OPTIONS** holds the manual controls: join by code, create a room, and whether that room is listed publicly.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Mouse | Look (pointer lock) |
| Left click | Fire |
| Scroll wheel | Cycle weapon |
| 1 / 2 / 3 | Select BUBBLEGUN / MARSHMALLOW / LOLLIPOP |
| R | Reload |
| Shift | Sprint |
| Space | Jump |
| Tab (hold) | Scoreboard |
| Esc | Release pointer / pause |

### Touch controls

On a touch device the on-screen controls appear on their own — no setting to find. Landscape is strongly preferred; portrait raises a dismissible nudge.

| Input | Action |
|---|---|
| Drag on the left half | Move (analog thumbstick; the base spawns wherever your thumb lands) |
| Push the stick fully forward | Sprint |
| Drag on the right half | Look; a quick tap fires |
| FIRE | Hold to aim and release to fire; BUBBLEGUN remains hold-for-full-auto |
| ⤒ | Jump |
| ⟳ | Reload |
| 1 / 2 / 3 | Select BUBBLEGUN / MARSHMALLOW / LOLLIPOP |
| ☰ | Toggle scoreboard |
| ❚❚ | Pause |

Append `?touch=1` to force the controls on, or `?touch=0` to force them off — useful for testing the layout on a desktop.

## Weapons

| # | Name | Type | Mag | Damage | Notes |
|---|---|---|---|---|---|
| 1 | BUBBLEGUN | SMG | 30 | 15 | Full-auto, 720 RPM, 1.9x headshot |
| 2 | MARSHMALLOW | Shotgun | 7 | 13 × 9 | Pump-action, 95 RPM, close range |
| 3 | LOLLIPOP | Rifle | 10 | 52 | Semi-auto, 165 RPM, 2.2x headshot |

## Architecture

Pastel Nuketown uses a single-file client architecture. The game ships as one `index.html` assembled by `build.sh` from numbered source parts in `src/`. There is no bundler, no framework, and no build tooling beyond a shell script.

```
src/
  00-head.html      <head> styles and meta
  01-body.html      HUD markup
  10-core.js        math utilities, constants
  20-world.js       Three.js scene, map geometry from mapspec.js
  30-physics.js     AABB collision, raycasts, movement
  40-weapons.js     weapon stats, viewmodel, projectiles
  50-actors.js      character models, animation
  60-fx.js          particles, tracers, muzzle flash
  70-game.js        match flow, player control, combat, bot wiring
  75-network.js     multiplayer client (WebSocket, interpolation, prediction)
  78-touch.js       on-screen controls for touch devices
  80-ui.js          HUD, killfeed, scoreboard, screens
  90-main.js        boot, camera, render loop
```

Shared modules consumed by both the browser client and the Node.js server:

| File | Purpose |
|---|---|
| `mapspec.js` | Map geometry contract (solids, platforms, stairs, spawns) |
| `net-protocol.js` | Wire format, message validation, protocol constants (VERSION, MAX_PLAYERS) |
| `bots.js` | Navigation mesh and bot AI (easy / normal / hard difficulty) |
| `server.mjs` | Host-authoritative WebSocket relay with rate limiting and backpressure |

`index.html` is a build artefact. Edit files in `src/` and the shared modules, then run `npm run build`.

## Development

```bash
npm run build      # reassemble index.html from src/
npm test           # run the test suite (node --test)
npm run check      # syntax-check every source file + tests + build freshness
```

The test suite covers bot navigation, weapon validation, wire protocol parsing, room lifecycle, origin allowlisting, hostile-input rejection, and — through a headless harness that runs the real client — guest-side prediction, the host/guest fairness baseline, and the matchmaking decisions PLAY makes on the player's behalf.

### The pre-commit hook

`index.html` is tracked, so every commit touching `src/` has to carry a rebuilt copy or `npm run check` fails on build freshness. Forgetting surfaces later as a red branch rather than at the moment it was caused, so `.githooks/pre-commit` rebuilds and stages the artefact alongside the change that caused it.

```bash
git config core.hooksPath .githooks     # or: cp .githooks/pre-commit .git/hooks/
```

It runs only when a build input is staged, stays out of rebases, merges and docs-only commits, and aborts rather than committing if `build.sh` fails.

## Deployment

`deploy/provision.sh` provisions the multiplayer relay on a fresh Ubuntu 24.04 server. It sets up a systemd service, nginx reverse proxy, and TLS certificates. Configuration is via environment variables documented in the script header (`DOMAIN`, `SITE`, `ALLOWED_ORIGINS`, `BRANCH`).

## FAQ

**Does Pastel Nuketown require a download or install?**
No. Pastel Nuketown runs entirely in the browser. Open the page, click the canvas, and play. The only server-side requirement is Node.js >= 18.14 to run the WebSocket relay.

**How many players can join a multiplayer room?**
Up to 9 players per room. The server enforces this limit in the protocol (`MAX_PLAYERS = 9`), and it is set to the combatant count on purpose: a room that fills up is nine real players with no bots in it. Below that, bots make up the difference, so a match is always nine combatants either way.

**How do I find a game?**
Press PLAY. It picks the busiest room with a seat free and opens one for you if there is nothing to join, then the match starts on a countdown. You never have to know what a room code is unless a friend sends you one.

**Can I join a match that has already started?**
Yes. Running rooms appear in the browser marked `IN PROGRESS` with a DROP IN button, and PLAY will pick one. You spawn with a shield and the bot wearing your jersey gives up its seat, so the match keeps its nine combatants. Leave and a bot takes the seat back.

**Can I play without other people?**
Yes. Solo mode fills the arena with 8 AI bots across three difficulty levels. Bots use A* pathfinding on a navigation mesh and exhibit patrol, hunt, engage, reposition, and retreat behaviours.

**What browsers are supported?**
Any modern evergreen browser: Chrome, Firefox, Edge, and Safari. The game uses Pointer Lock, WebGL (via Three.js), and WebSockets.

**Can I play on a phone or tablet?**
Yes. Touch devices get on-screen controls automatically: an analog thumbstick on the left, look-drag or tap-to-fire on the right, and a fire / jump / reload cluster with weapon chips. The shotgun and rifle fire when you lift from FIRE, so you can hold to aim first; the BUBBLEGUN still starts immediately and fires for as long as you hold. Pointer Lock is not used on touch — it would swallow the drag events the controls need — so pausing is a button rather than Esc. Landscape is recommended; portrait shows a dismissible nudge. The stick is analog end to end, including over the network: the wire protocol already carried movement as clamped floats, so a half-push travels as a half-push.

**Is there a game engine or framework?**
No. Pastel Nuketown is written in vanilla JavaScript with Three.js for rendering. There is no React, no Unity, no Godot, and no bundler. The build step is a shell script that concatenates source files.

**How does multiplayer networking work?**
The server (`server.mjs`) runs a host-authoritative relay over WebSockets. Clients send sanitised input; the server broadcasts snapshots and events. The client interpolates remote players and predicts local movement. The wire format is defined in `net-protocol.js`, a shared module used by both client and server.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution protocol. In short:

- **Bug?** Open an issue with the bug template. Include browser, repro steps, and console output.
- **Feature idea?** Open an issue with the feature template. Explain why it is fun and what it touches.
- **Protocol change?** Open an RFC-style issue first. `net-protocol.js` is a shared contract; do not change it in a drive-by PR.
- **PR?** Run `npm run check` before pushing. One concern per PR.

## License

Private. All rights reserved.
