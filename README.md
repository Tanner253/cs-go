# NULLPOINT (working title)

A round-based tactical shooter for the browser — desktop and mobile. Attackers plant a
charge on one of two sites; defenders stop them or disarm it. The focus is gunplay and
movement: learnable spray patterns, first-shot accuracy, counter-strafing, and authored
first-person weapon animations.

TypeScript, three.js and Vite. The level is generated at load; weapons, arms, animation and
sound are real assets (see [CREDITS.md](CREDITS.md)).

## Run it

```bash
npm install
npm run dev          # game client at http://localhost:5180
npm run dev:server   # game server for online duels at ws://localhost:8787
npm test             # simulation, bot and network tests
npm run build        # typecheck + production client in dist/
```

URL flags: `?spectate=1` (watch bots), `?nolock=1` (no pointer lock, for automated testing),
`?arena=3` (join arena 3 straight away), `?server=wss://host` (use another game server).

## Modes

- **Play online** — 1v1 duel on a server-authoritative match. Five arenas run at once; a match
  starts when two players are in one. First to 7 rounds, sides swap after 6.
- **Practice** — the full round loop offline against bots, 1v1 up to 5v5.

## Deploying

The site is static and goes on Vercel (`vercel.json`). The game server needs a process that
stays alive, which Vercel's functions cannot give a match (connections are cut at the function
time limit and two players are not guaranteed the same instance), so it runs on Render:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Tanner253/cs-go)

The blueprint (`render.yaml`) creates a free web service called `nullpoint-duel-server`. The
client expects it at `wss://nullpoint-duel-server.onrender.com`; if Render gives the service a
different address, set `VITE_SERVER_URL` in the Vercel project to `wss://<that-address>` and
redeploy. Free Render services sleep when idle, so the first connection can take up to a minute;
the lobby screen says so while it waits.

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move / look | WASD / mouse | left stick / drag |
| Fire / scope | left click / right click | FIRE / ZOOM |
| Jump / crouch / walk | Space / C or Ctrl / Shift | JUMP / DUCK |
| Reload / use | R / E (plant, disarm) | RLD / USE |
| Inspect weapon | F | — |
| Armory / weapons | B / 1 2 3, Q, wheel | BUY / SWAP |
| Scoreboard / pause | Tab / Esc | II |

## Architecture

```
src/sim/      engine-agnostic simulation (no DOM, no three.js); runs on client and server
  world.ts movement.ts weapons.ts map.ts nav.ts bot.ts game.ts
src/net/      protocol.ts (snapshots, messages)   replica.ts (prediction, interpolation)
server/       index.ts — lobbies and authoritative 64 Hz matches (Node + ws)
src/client/   game.ts (loop)  gfx.ts world.ts effects.ts (rendering)  viewmodel.ts assets.ts
              (weapon packs)  characters.ts  audio.ts  input.ts  hud.ts  menu.ts  net.ts  settings.ts
public/assets weapon packs (GLB) and sounds
tests/        sim, bots and a real-server network test
```

Online, the client predicts its own player every tick and re-simulates from each server
snapshot (32 per second); the opponent is drawn 100 ms in the past, interpolated; the server
rewinds targets to what the shooter saw when testing hits.

## Not built yet

Grenades, weapon drops, overtime, online matches larger than 1v1, reconnecting to a match,
anti-cheat beyond server authority, direction-specific strafe animations and hit reactions
for other players, a shotgun model (the shotgun is out of the armory until it has one), and audio
compressed for download size (sounds ship as WAV).
