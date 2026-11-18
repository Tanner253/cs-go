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

## The level

"Relay" (`src/sim/map.ts`): attackers spawn south, defenders north, three lanes between them.
A long runs down the east side and narrows to one doorway half way (the long doors); B tunnels
run down the west side under a roof and turn through an S-bend, so there is no straight line
through them; mid is split by a core, with connectors through the buildings either side and a
"short" opening into each site. A is an open site under a raised platform the defenders hold,
three steps up; B is fought round a pillar in its middle. Boxes stand singly and stacked, and
the 1.4 m ones are climbed with a crouch-jump.

The radar (`src/client/radar.ts`) is centred on you and turns with you, over an overview painted
from the level itself: the walkable floor (raised floors lighter), walls, cover, covered
stretches and the two sites. Teammates show with the way they face; an enemy shows while you
can see them, and a fading ring where they were last seen. When you die, a card shows who
killed you, with what, and the damage you and each enemy traded that round.

## Movement

Counter-Strike's own numbers (`src/sim/movement.ts`): ground and air acceleration, friction and
the stop speed, so counter-strafing and air-strafing work as they do there; each gun has its own
run speed, and a scoped sniper is slower again. Walking (shift) and crouching are silent.

- **Stamina.** A jump and a landing each cost stamina in proportion to the vertical speed (0.08
  and 0.05 of it, to 80, bleeding off at 60 a second); while any is spent the player is slowed
  on the ground and jumps lower. A running jump lands at about half speed and is back to full
  in about half a second; a jump the moment the feet touch keeps its speed but goes lower.
- **Crouch-jump.** Crouching in the air draws the legs up as far as it lowers the eyes: feet
  clear 1.62 m instead of 1.39, enough for the 1.4 m crates a plain jump can't reach. Jump and
  crouch pressed together work, as a crouch still on its way down finishes in the air.
- **Crouch spam.** Each press of crouch slows the next; a fourth in a row takes nearly three times
  as long, and the speed grows back over about three seconds.
- **Tagging.** A hit cuts run speed to half (a heavy hit) or two thirds (a light one), growing
  back over a second or less.
- **Landing.** A landing throws the aim open by half the gun's in-air inaccuracy, bleeding off as
  its spray does, so a jump-peek can't be shot accurately the moment the feet touch.

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

The knife works as Counter-Strike's: left click slashes (40, then 25 for each slash that follows
within a second, 90 from behind; one every 0.4 s, 0.5 s after a hit), right click stabs (65, or
180 from behind; once a second, and it reaches less far). "From behind" is judged by where the
attacker stands, within about 60 degrees of the victim's back. In first person a slash is one
of the pack's two cuts in turn and a stab its forward thrust; bots stab when it will kill or
when they are at someone's back.

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
arms of his sniper pack. The Mako, Hornet, Stinger and Thresher play packs animated for those very
guns by other makers, on other skeletons and without arms: the rifle pack's arms are posed after
them every frame (`src/client/worn-arms.ts`: each hand turned and placed as theirs, every finger
laid along theirs, the arm solved to reach it). The guns are shot over their own sights: nothing is fitted to a gun that
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
weapon family has its own handling sounds. Footsteps and impacts are Kenney's CC0 impact
recordings, used as recorded: a round on concrete sounds a pick striking rock, on the steel
crates a strike on plate. What a round throws off the surface is drawn with the explosion cards
(`Blasts.hit`): spark streaks (a shower off steel, a few off concrete), a puff of the surface's
dust and falling chips, and it leaves a hole.

**Suppressors.** The Osprey, Lumen, Hornet and Breaker take one. Right click (ZOOM on touch) fits it or
takes it off, which takes 1.7 seconds and both hands. Fitted, the gun is quiet (heard from less
than half as far, by players and bots alike), shows no tracer and almost no flash, and climbs
15% less; its rounds lose 1.5% more of their damage with every 10 m. The Osprey comes with
its suppressor on; the other two come without.
The armory (B) lists them in columns as plain line icons, with stat bars for the one in
focus; press a column's number, then the item's.

**Grenades** (`src/sim/grenades.ts`), as Counter-Strike's: an HE grenade ($300, up to 98 damage at
its heart, 25 five metres out, armour takes half), two flashbangs ($200), a smoke ($300, eighteen
seconds of cloud) and a fire bomb (the attackers' molotov $400, the defenders' incendiary $500: seven
seconds of floor burning at 40 a second, put out by smoke); four at most. Key 4 takes one out (again,
the next kind). Pressing either button pulls the pin; letting go throws it: overarm (left), an
underarm lob (right) or in between (both), at up to 17 m/s plus some of your own speed, under 0.4 g,
losing over half its speed at each bounce. HE and flashbangs go off 1.6 s after leaving the hand,
smokes once they lie still, fire where it first lands. A flashbang blinds everyone who can see it,
up to five seconds looking straight at it, about one with it behind you; the white thins and leaves
the frozen picture of the moment it went off. Smoke hides players from the server's sight test and
from the bots as well as from the eye; standing in it greys the view (your own gun stays clear).
In first person the throw is an authored one, DJMaesen's "Arms throwing" (`src/client/nade-view.ts`),
in the same gloves as the pistols and snipers: the press winds the arm up over the shoulder and
flicks the pin away, letting go brings it over and forward, the grenade leaves the hand where the
hand is fastest, and the lever flies off. Bots buy grenades and throw them (`src/sim/bot-nades.ts`): each throw is first flown in the
bot's head against the real level, so it banks off walls and lobs over cover only where that
works: smokes and a flash on a site they are taking, HE and fire at enemies known to be behind
cover, fire on the charge when defenders close on it; they turn away from their own flashbangs.

**Weapons on the floor** (`src/sim/drops.ts`), as in Counter-Strike. G throws down the gun in
hand (or one grenade of the kind in hand; never the knife), ahead and a little up from the aim;
it falls under full gravity, clatters (a recorded strike on steel) and slides to a stop, keeping
its magazine, reserve and suppressor. The dead let fall their best gun (a pistol only when they
had no main gun) and the grenade in hand. Buying a gun for a slot already filled sets the old one
down at the buyer's feet, so a gun can be bought for a teammate in the freeze. Walking over a gun
fills an empty slot (whoever threw it down only after a second) and takes it up if it is better
than what is in hand; E takes the gun looked at within 2.4 m, or the one stood on, trading the gun
in that slot for it. Either side may carry the other's guns. Bots go over and take a much better
gun lying close by when nothing presses. Whatever is on the floor is cleared when the next round
starts. The guns lie on their side with the models and skins the players carry
(`src/client/drops-view.ts`), and the server sends them to clients like grenades.

**Explosions** (`src/client/blast.ts`) are made in layers, as the ZONA project's are: the flash,
a fireball of fire photographs that swells, rises, boils and cools to soot, smoke lit from inside
while the fire lasts, dust rolled out along the floor and a ring of it, sparks and embers, the
floor left scorched, a light that flares and dies, all kept on the blast's side of nearby walls.

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
| Fire / scope or suppressor (knife: slash / stab) | left click / right click | FIRE / ZOOM |
| Jump / crouch / walk | Space / C or Ctrl / Shift | JUMP / DUCK |
| Reload / use | R / E (plant, disarm, pick up a gun) | RLD / USE |
| Drop the gun in hand | G | DROP |
| Inspect weapon | F | — |
| Armory / weapons | B / 1 2 3, 4 (grenades), Q, wheel | BUY / SWAP |
| Throw a grenade | left click (overarm), right click (lob), both | FIRE / ZOOM |
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

Overtime, online matches larger than 1v1, reconnecting to a match,
strafe animations of their own (other players' legs turn toward a strafe; walking and crouching backwards already have their own movements), and audio compressed for download size (sounds ship
mostly as WAV).
