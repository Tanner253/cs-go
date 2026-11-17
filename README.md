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
node tools/build-sounds.mjs   # rebuild public/assets/audio from the raw CC0 packs
```

URL flags: `?spectate=1` (watch bots), `?nolock=1` (no pointer lock, for automated testing),
`?arena=3` (join arena 3 straight away), `?server=wss://host` (use another game server).

## Modes

- **Play online** — 1v1 duel on a server-authoritative match. Five arenas run at once; a match
  starts when two players are in one. First to 7 rounds, sides swap after 6.
- **Practice** — the full round loop offline against bots, 1v1 up to 5v5.

## Weapons

| | Attackers | Defenders |
|---|---|---|
| Sidearm | Kite-9 (M9), Stinger MP (Škorpion, automatic) | Tern P7 (1911) |
| SMG | Wasp SMG | Hornet PDW (MP7) |
| A gun in each hand | Viper Twins (two MAC-10s) | Wren Twins (two SMGs) |
| Shotgun | Thresher DB (sawn-off double barrel) | Breaker (M3 pump) |
| Budget rifle | Mako Carbine (AKS-74U) | Osprey SD (9A-91, comes suppressed) |
| Rifle | Hammerhead AR (AK) | Lumen AR (AR-15) |
| Sniper | Colossus .50 (M82, semi-automatic) | Longsight AWP (bolt-action) |
| Both sides | Maul .50 (Desert Eagle), Edge knife | |

Either sniper kills with one shot to the body or head; bots buy them too (one a side, when the
team can afford it) and fight from the scope. A shotgun's pellets fill a cone of fixed size,
thickest in the middle; moving and jumping throw the whole cone off the aim. The twin guns fire
left and right in turn.

Each has its own model, sound, stats and painted skin (`src/client/skins.ts`): a pattern with
light-emitting lines that flare as the gun heats up, and a magazine that glows as an ammo
gauge. Each gun model is mounted piece by piece on the joints of an animated arm pack
(`src/client/assets.ts`): the rifles in a pack animated for an AK and the submachine guns in one
animated for an SMG (their own draw, firing movement, reload and inspection); pistols, shotguns,
the AWP and the knife in packs by one artist; the .50 and the twin guns in that artist's packs
made for them (their own firing, reload, action and draw), which are skeletons only and wear the
arms of his sniper pack. The guns are shot over their own sights: nothing is fitted to a gun that
did not come with it.

**Handling.** The arm packs' clips move the hands; `src/client/moves.ts` carries the gun where
the eye can follow it and says when each moment is heard. A rifle is rolled on its side for the
magazine change and its action is then worked by the left hand; the pump shotgun is fed shell
by shell and pumped; the break-action is turned side on and broken open; an empty pistol has
its slide let go. Every gun and the knife can be looked over (F). Each moment of a reload is
its own sound, played as the hands reach it. A gun is brought up muzzle-down from the hip
and settles as the left hand takes hold. Other players show the same handling: the gun comes
down out of the shoulder for a reload while the left hand goes to the magazine, the pouch and
the action, and it is raised from the hip when drawn.

**Sound.** Every gunshot, reload, rack and bolt is a recording of a real gun (Snake's Authentic
Gun Sounds, packs 1 and 2: see CREDITS.md), cut at the shot by `tools/build-sounds.mjs`, played
a little faster or slower where one calibre stands in for another, faded and levelled; each
weapon family has its own handling sounds. Footsteps and impacts are built from Kenney's CC0
impact recordings.

**Suppressors.** The Osprey, Lumen, Hornet and Breaker take one. Right click (ZOOM on touch) fits it or
takes it off, which takes 1.7 seconds and both hands. Fitted, the gun is quiet (heard from less
than half as far, by players and bots alike), shows no tracer and almost no flash, and climbs
15% less; its rounds lose 1.5% more of their damage with every 10 m. The Osprey comes with
its suppressor on; the other two come without.
The armory (B) lists them in columns as plain line icons, with stat bars for the one in
focus; press a column's number, then the item's.

## Cheat resistance

The server is the only authority; a client sends inputs and nothing else.

- **Movement and collision** run on the server. A client cannot report a position.
- **Hits** are decided on the server against its own record of where players were. Walls stop
  every bullet (`rules.wallbang` is off).
- **No wallhack data**: an enemy the player has no line of sight to is sent without a position
  (`server/visibility.ts`), so a modified client has nothing to draw.
- **Lag compensation is bounded** by the latency the server itself measures.
- **Spread** comes from a server-side secret, so it cannot be predicted or chosen.
- **Input rate**: one command per player per tick; backlogs are trimmed, floods are disconnected.
- **Nothing a player could not see**: an enemy in view is sent without health, armour, money,
  ammunition or the rest of their kit, and what they buy, draw or reload is told only to them.
- Purchases, names, angles and message sizes are validated server-side. Set `ALLOWED_ORIGINS`
  on the server to accept connections only from your site. An out-of-date page cannot join; an
  address may hold 8 connections (`MAX_PER_ADDRESS`).

### Detection (`server/anticheat.ts`)

What is left to a cheat is aiming or timing its input by program. The server judges that from
each player's stream of commands, looking only for what a hand on a mouse cannot do, and only
acts once it has happened repeatedly:

| Detector | What it catches |
|---|---|
| snap | the aim arrives at speed, stops dead on a target's centre, and hits |
| flickback | the aim is on the target for the one tick of the shot, then back ("silent aim") |
| lock | the aim stays within 0.15° of a moving target's centre through a change of direction |
| recoil | a spray's recoil cancelled to within 0.06° |
| spin | the view turning faster than 1600°/s while still landing hits |
| timer | commands arriving faster than real time (a sped-up client) |
| protocol | messages the game cannot produce |

A player it is sure of is removed from the match, the opponent is told why, and the address is
kept out for 15 minutes (`BAN_MINUTES`). `ANTICHEAT=log` only writes what it sees; `off`
disables it. Counts are on the server's status page (`/`). `tests/anticheat.test.ts` plays six
simulated cheats and two simulated honest players (one strong, one at a low frame rate) against
it.

What this does not stop: a cheat that aims like a person (slow, imprecise, with human error).
Catching that takes more play data than a duel provides, or software on the player's machine,
which a browser game cannot have.

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
| Fire / scope or suppressor | left click / right click | FIRE / ZOOM |
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
              visibility.ts (who may be told where whom is)  anticheat.ts (detection)
src/client/   game.ts (loop)  gfx.ts world.ts effects.ts (rendering)  viewmodel.ts assets.ts
              (weapon packs)  characters.ts  audio.ts  input.ts  hud.ts  menu.ts  net.ts  settings.ts
public/assets weapon packs (GLB) and sounds
tests/        sim, bots, anti-cheat and a real-server network test
```

Online, the client predicts its own player every tick and re-simulates from each server
snapshot (32 per second); the opponent is drawn 100 ms in the past, interpolated; the server
rewinds targets to what the shooter saw when testing hits.

## Not built yet

Grenades, weapon drops, overtime, online matches larger than 1v1, reconnecting to a match,
direction-specific strafe animations, and audio compressed for download size (sounds ship
mostly as WAV).
