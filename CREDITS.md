# Credits

Third-party work shipped with NULLPOINT. The same list is shown in the game's Credits tab
(`src/client/credits.ts`). The weapon packs and sounds were prepared by the ZONA project's
asset pipeline and copied from there unchanged unless noted.

## First-person weapons, arms and animation — CC BY 4.0

- This work is based on "FPS AK-74m animations" (https://sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14) by Cransh (https://sketchfab.com/ccransh) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
  Files: `public/assets/weapons/ak_fp.glb`, `ak.glb`.
  Changes made: scaled to metres; its eight animations laid end to end as one; the rifle taken off its skeleton in pieces (rifle, bolt, trigger, safety, magazine) and hung back on the arm joints at run time; textures re-encoded as WebP; geometry compressed. Recoloured in game for the second rifle.
- This work is based on "SMG FPS Animations" (https://sketchfab.com/3d-models/smg-fps-animations-ca37ea9148dc4fcc9cc632175d311b23) by Cransh (https://sketchfab.com/ccransh) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/smg_fp.glb`, `smg.glb`.
  Changes made: as above.
- "animated pistol" (https://skfb.ly/ooPqJ) by DJMaesen is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).
  Files: `public/assets/weapons/m9_fp.glb`.
  Changes made: its one long animation cut into the movements the game plays; textures re-encoded as WebP; geometry compressed. Recoloured in game for the other two pistols.
- "sniper animated" (https://sketchfab.com/3d-models/sniper-animated-b48999a250b2433da59f705c371a49b2) by DJMaesen is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).
  Files: `public/assets/weapons/sniper_fp.glb`.
  Changes made: scaled to metres; its one long animation cut into movements; textures re-encoded as WebP; geometry compressed.
- This work is based on "knife Animated" (https://sketchfab.com/3d-models/knife-animated-f3140db917cc43389c14b5b2536c1dc8) by DJMaesen (https://sketchfab.com/bumstrum) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/knife_fp.glb`.
  Changes made: scaled to metres; its one long animation cut into movements; its arms drawn with the textures of the same maker's sniper pack; textures re-encoded as WebP; geometry compressed.

## Player character

- This work is based on "Military tactical suit (LowPolyGameReady)" (https://sketchfab.com/3d-models/military-tactical-suit-lowpolygameready-ef698ce36b1545a78ce592dd3db4c7ed) by DanlyVostok (https://sketchfab.com/1799danly) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
  Files: `public/assets/characters/survivor.glb`.
  Changes made: the suit, head, plate carrier, pouches, pads, cap and headset were put onto another skeleton (every point moved from the joints it was made on to that skeleton's); textures re-encoded as WebP at a quarter of their size; geometry compressed; its own animation is not used. Tinted per team in game.
- The skeleton and every movement are from two packs by [Quaternius](https://quaternius.com), Universal Base Characters and the Universal Animation Library (CC0 1.0).
  Files: `public/assets/characters/survivor.glb`, `moves.glb`.
- The weapons other players are seen holding are reduced copies of the first-person models credited above.
  Files: `public/assets/weapons/world/*.glb`.

## Sounds

Files: `public/assets/sounds/*.wav`.

- Gunshots, the bolt, magazines and the slide: [Snake's Authentic Gun Sounds](https://f8studios.itch.io/snakes-authentic-gun-sounds) by Snake (free to use), and [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney (CC0 1.0). Cut and levelled.
- Footsteps, impacts, thuds: [Impact Sounds](https://kenney.nl/assets/impact-sounds) by Kenney (CC0 1.0). The charge beep: [Digital Audio](https://kenney.nl/assets/digital-audio) by Kenney (CC0 1.0). Punches: [Punch](https://opengameart.org/content/punch) by qubodup (CC0 1.0).

## Code and fonts

- [three.js](https://threejs.org) — MIT.
- [Rajdhani](https://fonts.google.com/specimen/Rajdhani) by Indian Type Foundry — SIL Open Font License 1.1 (via `@fontsource/rajdhani`).
- [ws](https://github.com/websockets/ws) — MIT.

Everything else — the level, effects, interface and game code — is original to this project.
