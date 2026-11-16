# NULLPOINT (working title)

An original 5v5 round-based tactical shooter for the browser — desktop and mobile.
Attackers plant a charge on one of two sites; defenders stop them or disarm it.
The twist is vertical play: wall-jumps, ledge mantling and a grapple hook, with rooftops in bounds.

Built with TypeScript, three.js and Vite. No art or audio downloads: geometry, textures and
sound are generated at runtime, so the whole game is a ~170 kB (gzip) bundle.

## Run it

```bash
npm install
npm run dev        # http://localhost:5180
npm test           # headless simulation tests (includes a full bot-vs-bot match)
npm run build      # typecheck + production bundle in dist/
```

Useful URL flags: `?spectate=1` (all bots, watch through one of them), `?nolock=1` (no pointer lock; hold middle mouse to look — for automated testing).

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move / look | WASD / mouse | left stick / drag right side |
| Fire / scope | left click / right click | FIRE / ZOOM |
| Jump, wall-jump | Space (tap again in the air against a wall) | JUMP |
| Mantle a ledge | hold Space while pushing into it | hold JUMP |
| Grapple | hold F or middle mouse | hold HOOK |
| Crouch / walk | C or Ctrl / Shift | DUCK |
| Reload / use | R / E (plant, disarm) | RLD / USE |
| Armory / weapons | B / 1 2 3, Q, wheel | BUY / SWAP |
| Scoreboard | Tab | — |

## What is in the MVP

- **Movement** — Quake/Source-lineage acceleration and friction (counter-strafing, air-strafing, bunny hops), crouch, silent walk, stair stepping, fall damage, plus wall-jump, mantle and grapple.
- **Gunplay** — nine weapons as plain data; deterministic learnable spray patterns; first-shot accuracy; movement, air and sustained-fire inaccuracy; hit groups, armour and helmets, range falloff, wall penetration, tagging; scoped sniper; knife with backstab.
- **Rules** — freeze/buy time, 1:55 rounds, plant (3.2 s) / disarm (10 s, 5 s with kit), 40 s fuse, first to 13 with a side swap at half, kill rewards, win and loss-streak bonuses, buy zones.
- **Bots** — nine bots play the full objective through the same input path as a human: automatic nav grid, A*, site executes, holds, rotations, retakes, burst control, recoil compensation, four skill levels.
- **Presentation** — procedural viewmodels with spring sway, bob, recoil, draw, reload and melee animation; tracers, impacts, bullet holes, shell ejection; synthesised positional audio; full HUD, armory, scoreboard, kill feed; touch controls.

## Architecture

```
src/sim/      engine-agnostic game simulation (no DOM, no three.js)
  world.ts      AABB collision: hull sweeps, raycasts
  map.ts        "Relay" blockout, sites, spawns, bot routes
  movement.ts   player movement incl. wall-jump, mantle, grapple
  weapons.ts    weapon catalogue and spray patterns
  nav.ts        auto-generated nav grid + A*
  bot.ts        bot brains (produce input commands only)
  game.ts       Sim: 64 Hz tick, combat, rounds, economy, objective
src/client/   presentation
  game.ts       loop, camera, glue        world.ts      merged map meshes
  viewmodel.ts  first-person weapons      characters.ts third-person models
  effects.ts    pooled VFX                audio.ts      WebAudio synth
  input.ts      keyboard/mouse/touch      hud.ts        DOM HUD
tests/        vitest suite for the sim
```

The simulation advances only from per-player `Cmd` structs on a fixed 64 Hz tick and emits
events. That is the seam for multiplayer: the same `Sim` class can run on an authoritative
Node server while clients predict with it locally.

## Not built yet

Online multiplayer (server, prediction, lag compensation), grenades (smoke/flash/frag/incendiary),
weapon drops and pickups, radar, overtime, spectator controls, voice/radio, settings beyond
sensitivity and volume, and real art: the map is a graybox and characters, hands and weapons
are primitives with procedural animation, not authored or motion-captured assets.

See [docs/REFERENCES.md](docs/REFERENCES.md) for the open-source projects worth borrowing from next.
