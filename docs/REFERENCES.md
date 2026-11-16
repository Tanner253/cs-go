# Open-source options to borrow from

Survey run 2026-11-15. Licences, stars and dates were read from GitHub at that time; READMEs
were read but source quality was not audited. Re-check a licence before copying anything.

Two repos are cloned locally in `_reference/` (git-ignored, never built or run) for study:
`claude-of-duty` and `webstrafe`. Both carry an MIT `LICENSE` file.

## Best candidates

| What we need | Project | Licence | Take |
|---|---|---|---|
| Netcode design | [colyseus/colyseus](https://github.com/colyseus/colyseus) 0.18 | MIT | Prediction, reconciliation and rewind lag-compensation design; WebSocket/WebTransport transports |
| Unreliable transport | [geckosio/geckos.io](https://github.com/geckosio/geckos.io) + [snapshot-interpolation](https://github.com/geckosio/snapshot-interpolation) | BSD-3 | UDP-style WebRTC data channels to Node; snapshot buffer for remote players |
| Bots on vertical routes | [isaac-mason/navcat](https://github.com/isaac-mason/navcat) | MIT | Pure-TS navmesh with off-mesh links (jump / mantle / grapple edges) |
| Bot decision making | [Mugen87/yuka](https://github.com/Mugen87/yuka) | MIT | Goal-driven agents, perception and memory |
| Source-style movement on mesh maps | [yassinsolim/WebStrafe](https://github.com/yassinsolim/WebStrafe) | MIT | 128 Hz controller, surf-ramp clipping, BVH collision vs triangle meshes (same stack as ours) |
| Wall-run, slide, dash states | [Jeh3no/Godot-Advanced-State-Machine-First-Person-Controller](https://github.com/Jeh3no/Godot-Advanced-State-Machine-First-Person-Controller) | MIT | Port the state logic, coyote time and jump buffering |
| Grapple feel | [OverlordDestro/DestroHook](https://github.com/OverlordDestro/DestroHook) | MIT | Spring-based grapple maths (Godot, portable) |
| Viewmodel + weapon feel | [mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty) | MIT | Mantle/slide/lean controller, spring recoil, procedural reloads, synthesised weapon audio. Its README says it was written by AI agents. Do not reuse its branding |
| Mesh collision queries | [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | MIT | Needed once maps stop being boxes |
| Round-loop reference | [guyz/tinystrike](https://github.com/guyz/tinystrike) | ISC | Bomb/economy/bot loop in three.js. One client is authoritative, so do not copy its netcode |

## Art and audio (free for commercial use)

| Asset | Licence | Notes |
|---|---|---|
| Quaternius Modular Sci-Fi MegaKit | CC0 | 277 grid-modular environment pieces, glTF |
| Kenney Space Station Kit, Blaster Kit, Sci-fi Sounds | CC0 | Environment pieces, weapon models, 70 sound effects |
| Quaternius Sci-Fi Essentials Kit | CC0 | Textured guns and animated robots |
| Poly Haven | CC0 | HDRIs, PBR textures |
| J-Toastie FPS pack (poly.pizza) | CC-BY 3.0 | Rigged, animated arms + rifle + pistol. Attribution required |
| cemcakirca FPS arms (itch.io) | CC0 | Rigged arms, no animations |

## Do not copy

These are ports, reimplementations or original sources of commercial games, copyleft, or
unlicensed. They are fine to read for ideas, not to lift code or assets from.

- Ports / reimplementations of commercial games: `mrdoob/three-quake` (GPL-2.0, bundles game data), `inolen/quakejs` (pulls Quake 3 assets), `VadimDez/Counter-Strike-JS` (no licence, needs original game files), `R2Northstar/Northstar` (Titanfall 2).
- Original engine sources: `id-Software/Quake-III-Arena` (GPL-2.0), `ValveSoftware/source-sdk-2013` (Valve's own licence — do not port its movement code).
- Copyleft: `whitwhoa/open-browser-fps` (GPL-3.0).
- No licence (all rights reserved by default): `minism/fps-netcode`, `chrisbuczek/threejs-multiplayer-fps`, `Henrique-Teruya/float-parkour-game`, `iErcann/NotBlox`.

## Gaps

No permissively licensed web project was found that already combines mantling with a grapple
hook, and there is no reliable way to tell which AI model wrote a given repository unless its
README says so.
