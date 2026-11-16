# Credits

Third-party work shipped with NULLPOINT. The same list is shown in the game's Credits tab
(`src/client/credits.ts`). The weapon models, their arm packs and the player character were
prepared by the ZONA project's asset pipeline and copied from there unchanged unless noted.
No sounds come from ZONA.

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

- This work is based on "AR-15" (https://sketchfab.com/3d-models/ar-15-33e225811b404192b89dcd4096603fbe) by wafla (https://sketchfab.com/wafla) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/ar15_lod1.glb`. Changes made: scaled to metres and set in separate pieces (rifle, magazine, brake, sight and unused attachments); reduced in detail; textures re-encoded as WebP; geometry compressed. Held in the arms of the AK pack.
- This work is based on "Colt 1911" (https://sketchfab.com/3d-models/colt-1911-561fccb5b3314feda06da315b8d36553) by AlexChuchvaga (https://sketchfab.com/AlexChuchvaga) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/colt_1911.glb`, `world/colt_1911_lod1.glb`. Changes made: taken off its skeleton and set in rigid pieces (frame, slide, hammer, magazine), scaled to metres; its own animation is not used; textures re-encoded as WebP; geometry compressed. Held in the arms of the pistol pack.
- This work is based on "Desert Eagle" (https://sketchfab.com/3d-models/desert-eagle-cabde59f5cf24effaf80536e35d04e95) by ELIZION (https://sketchfab.com/ELIZION) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/desert_eagle.glb`, `world/desert_eagle_lod1.glb`. Changes made: set in three rigid pieces (frame, slide, magazine), scaled to metres; textures re-encoded as WebP; geometry compressed. Held in the arms of the pistol pack.
- This work is based on "Benelli M3 Tactical" (https://sketchfab.com/3d-models/benelli-m3-tactical-1eaea0239fdf43ad92eb276fbf9c60dd) by Amapsis (https://sketchfab.com/Amapsis) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/benelli_m3.glb`, `world/benelli_m3_lod1.glb`. Changes made: set in rigid pieces and laid along the barrel; textures re-encoded as WebP; geometry compressed. Held in the arms of the sniper pack.
- This work is based on "MP7A1 Animations" (https://sketchfab.com/3d-models/mp7a1-animations-0a55689855594f2496c2debdb7e6f5bc) by TheParaziT (https://sketchfab.com/TheParaziT) licensed under CC-BY-4.0.
  Files: `public/assets/weapons/mp7a1.glb`, `world/mp7a1_lod1.glb`. Changes made: only the gun is used, set in rigid pieces; its own arms and animation are left out; textures re-encoded; geometry compressed. Held in the arms of the SMG pack.

## Player character

- This work is based on "Military tactical suit (LowPolyGameReady)" (https://sketchfab.com/3d-models/military-tactical-suit-lowpolygameready-ef698ce36b1545a78ce592dd3db4c7ed) by DanlyVostok (https://sketchfab.com/1799danly) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
  Files: `public/assets/characters/survivor.glb`.
  Changes made: the suit, head, plate carrier, pouches, pads, cap and headset were put onto another skeleton (every point moved from the joints it was made on to that skeleton's); textures re-encoded as WebP at a quarter of their size; geometry compressed; its own animation is not used. Tinted per team in game.
- The skeleton and every movement are from two packs by [Quaternius](https://quaternius.com), Universal Base Characters and the Universal Animation Library (CC0 1.0).
  Files: `public/assets/characters/survivor.glb`, `moves.glb`.
- The weapons other players are seen holding are reduced copies of the first-person models credited above.
  Files: `public/assets/weapons/world/*.glb`.

## Sounds

Files: `public/assets/audio/*`, built by `tools/build-sounds.mjs` from packs downloaded from
their own publishers. No sound is taken from another game.

- Gunshots: [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library), recorded by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney (CC0 1.0). One clean shot cut per take, faded out, resampled to 48 kHz mono and peak-normalised; no layering or effects.
- Footsteps, landings, hit and impact sounds, metal clicks: [Impact Sounds](https://kenney.nl/assets/impact-sounds) by Kenney (CC0 1.0). Interface sounds: [Interface Sounds](https://kenney.nl/assets/interface-sounds) by Kenney (CC0 1.0). Explosion: [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds) by Kenney (CC0 1.0). Decoded from Ogg to WAV.
- Reloads (CC0 1.0, from freesound.org, as prepared by the MIT-licensed [WebStrafe](https://github.com/yassinsolim/WebStrafe) project): [PistolReloadSound.wav](https://freesound.org/people/MaximBomba/sounds/432139/) and [Rifle-or-shotgun-reload.wav](https://freesound.org/people/MaximBomba/sounds/432141/) by MaximBomba.
- Knife (CC0 1.0, from freesound.org, as prepared by WebStrafe): [Knife Swing 1_4, 1_5 and 1_7](https://freesound.org/people/Joao_Janz/packs/27423/) by Joao_Janz; [Knife Stabs into Foam Block](https://freesound.org/s/870740/) by CHallSmith; [Knife Stab Pull](https://freesound.org/s/411742/) by neilsher; [Knife scrape and hit](https://freesound.org/s/434338/) by draftcraft; [Knife on Jeans](https://freesound.org/s/329358/) by bassoonrckr; [Schwing 1](https://freesound.org/s/524215/) by magnuswaker.
- The beep of the planted charge is synthesised.

## Code and fonts

- [three.js](https://threejs.org) — MIT.
- [Rajdhani](https://fonts.google.com/specimen/Rajdhani) by Indian Type Foundry — SIL Open Font License 1.1 (via `@fontsource/rajdhani`).
- [ws](https://github.com/websockets/ws) — MIT.

Everything else — the level, effects, interface and game code — is original to this project.
