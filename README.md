# Pastel Nuketown — Browser Multiplayer FPS Game

Pastel Nuketown is a free-to-play first-person shooter (FPS) game that runs entirely in the browser. Built with Three.js and vanilla JavaScript, it features a pastel-styled Nuketown-inspired arena with host-authoritative multiplayer over WebSockets. Play solo against AI bots or create a room for up to 4 players. No downloads, no plugins, no accounts — open the page and play.

![Pastel Nuketown title screen showing the pastel-coloured arena map with two houses, a bus, and a truck](shots/title.png)

![First-person gameplay screenshot showing the BUBBLEGUN SMG firing at an enemy in the Nuketown arena](shots/play/06-firing.png)

## Features

- **Browser-based FPS** — runs in any modern browser (Chrome, Firefox, Edge, Safari) with no install
- **Multiplayer rooms** — host-authoritative relay server supports up to 4 players per room with client-side interpolation and prediction
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
npm start          # builds index.html, then starts the relay on port 3000
```

Open `http://localhost:3000` in a modern browser. Click the canvas to lock the pointer and start playing.

### How to play on LAN with friends

The WebSocket relay accepts any origin by default. Players on your local network can connect at `http://<your-ip>:3000` without any configuration. To restrict origins in production, set `ALLOWED_ORIGINS` in `deploy/provision.sh`.

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
npm test           # run the test suite (node --test, 26 tests)
npm run check      # syntax-check every source file + tests + build freshness
```

The test suite covers bot navigation, weapon validation, wire protocol parsing, room lifecycle, origin allowlisting, and hostile-input rejection.

## Deployment

`deploy/provision.sh` provisions the multiplayer relay on a fresh Ubuntu 24.04 server. It sets up a systemd service, nginx reverse proxy, and TLS certificates. Configuration is via environment variables documented in the script header (`DOMAIN`, `SITE`, `ALLOWED_ORIGINS`, `BRANCH`).

## FAQ

**Does Pastel Nuketown require a download or install?**
No. Pastel Nuketown runs entirely in the browser. Open the page, click the canvas, and play. The only server-side requirement is Node.js >= 18.14 to run the WebSocket relay.

**How many players can join a multiplayer room?**
Up to 4 players per room. The server enforces this limit in the protocol (`MAX_PLAYERS = 4`).

**Can I play without other people?**
Yes. Solo mode fills the arena with 8 AI bots across three difficulty levels. Bots use A* pathfinding on a navigation mesh and exhibit patrol, hunt, engage, reposition, and retreat behaviours.

**What browsers are supported?**
Any modern evergreen browser: Chrome, Firefox, Edge, and Safari. The game uses Pointer Lock, WebGL (via Three.js), and WebSockets.

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
