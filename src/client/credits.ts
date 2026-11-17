// Third-party work shipped with the game. Keep in step with CREDITS.md.

export interface Credit {
  title: string;
  author: string;
  license: string;
  url: string;
  note?: string;
}

export const CREDITS: Credit[] = [
  {
    title: 'FPS AK-74m animations', author: 'Cransh', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14',
    note: 'Rifle arms and animations (draw, fire, reload, reload from empty) and the attacker rifle. The Mako, Lumen and Osprey are held in the same arms. Scaled to metres, set in pieces, textures re-encoded, geometry compressed.',
  },
  {
    title: 'SMG FPS Animations', author: 'Cransh', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/smg-fps-animations-ca37ea9148dc4fcc9cc632175d311b23',
    note: 'Submachine-gun arms and animations (draw, fire, reload, reload from empty, inspection) and the attacker SMG. The Hornet is held in the same arms. Scaled to metres, set in pieces, textures re-encoded, geometry compressed.',
  },
  {
    title: 'animated pistol', author: 'DJMaesen', license: 'CC BY 4.0',
    url: 'https://skfb.ly/ooPqJ',
    note: 'Pistol, arms and animation; one long animation cut into movements. Its arms also hold the other pistols and both submachine guns.',
  },
  {
    title: 'sniper animated', author: 'DJMaesen', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/sniper-animated-b48999a250b2433da59f705c371a49b2',
    note: 'Sniper rifle, arms and animation; one long animation cut into movements. Its arms also hold both rifles and the shotgun.',
  },
  {
    title: 'knife Animated', author: 'DJMaesen', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/knife-animated-f3140db917cc43389c14b5b2536c1dc8',
    note: 'Knife, arms and animation; one long animation cut into movements.',
  },
  {
    title: 'Military tactical suit (LowPolyGameReady)', author: 'DanlyVostok', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/military-tactical-suit-lowpolygameready-ef698ce36b1545a78ce592dd3db4c7ed',
    note: 'Player character. Fitted onto another skeleton, textures re-encoded, geometry compressed; tinted per team.',
  },
  {
    title: 'Universal Base Characters and Universal Animation Library', author: 'Quaternius', license: 'CC0 1.0',
    url: 'https://quaternius.com',
    note: 'Player skeleton and movement animations.',
  },
  { title: 'AR-15', author: 'wafla', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/ar-15-33e225811b404192b89dcd4096603fbe', note: 'Defender rifle. Reduced, set in pieces, held in the arms of the sniper pack.' },
  { title: 'Colt 1911', author: 'AlexChuchvaga', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/colt-1911-561fccb5b3314feda06da315b8d36553', note: 'Defender pistol. Set in rigid pieces, held in the arms of the pistol pack.' },
  { title: 'Desert Eagle', author: 'ELIZION', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/desert-eagle-cabde59f5cf24effaf80536e35d04e95', note: 'Heavy pistol. Set in rigid pieces, held in the arms of the pistol pack.' },
  { title: 'Benelli M3 Tactical', author: 'Amapsis', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/benelli-m3-tactical-1eaea0239fdf43ad92eb276fbf9c60dd', note: 'Shotgun. Set in rigid pieces, held in the arms of the sniper pack.' },
  { title: 'MP7A1 Animations', author: 'TheParaziT', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/mp7a1-animations-0a55689855594f2496c2debdb7e6f5bc', note: 'Defender SMG: the gun only, held in the arms of the pistol pack.' },
  { title: 'Scorpion | First Person Animations (2026 Remake)', author: '1Matzh', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/scorpion-first-person-animations-2026-remake-f2bdfac775344004ad38d0318f0664a4', note: 'Machine pistol: the gun only, held in the arms of the pistol pack.' },
  { title: 'Animated AKs-74u', author: 'Vlasov Daniil', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/animated-aks-74u-34220aaa62e44b34b7d5ac30701f2b5f', note: 'Attacker carbine: the gun only, held in the arms of the sniper pack.' },
  { title: '9A-91 Assault Rifle Gameready Lowpoly', author: 'valterjherson1', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/9a-91-assault-rifle-gameready-lowpoly-788797a8a6284a29a04961cb09072eda', note: 'Defender suppressed rifle. Set in rigid pieces, held in the arms of the sniper pack.' },
  { title: 'Barrett-M82 (Optimized)', author: 'Gintoki1234', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/barrett-m82-optimized-af16e974a47e463989311bcda6f51f87', note: 'Heavy sniper rifle. Set in rigid pieces, held in the arms of the sniper pack.' },
  { title: 'Shotgun animation set', author: 'Vlasov Daniil', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/shotgun-animation-set-c24e049dccfe4a1d837b1b0ae1461636', note: 'Double-barrel shotgun: the gun only, held in the arms of the sniper pack.' },
  {
    title: "Snake's Authentic Gun Sounds (packs 1 and 2)", author: 'Snake / F8 Studios', license: 'Free for commercial use',
    url: 'https://f8studios.itch.io/snakes-authentic-gun-sounds',
    note: 'Every gunshot, reload, rack, slide and bolt: recordings of real guns, used as recorded.',
  },
  {
    title: 'Impact Sounds, Interface Sounds, Sci-Fi Sounds', author: 'Kenney', license: 'CC0 1.0',
    url: 'https://kenney.nl/assets',
    note: 'Footsteps, hits, impacts, interface sounds and the explosion.',
  },
  {
    title: 'Reload and knife recordings', author: 'MaximBomba, Joao_Janz, CHallSmith, neilsher, draftcraft, bassoonrckr, magnuswaker (freesound.org)', license: 'CC0 1.0',
    url: 'https://github.com/yassinsolim/WebStrafe/blob/main/CREDITS.md',
    note: 'As prepared by the MIT-licensed WebStrafe project.',
  },
  {
    title: 'three.js', author: 'three.js authors', license: 'MIT',
    url: 'https://threejs.org',
  },
  {
    title: 'Rajdhani typeface', author: 'Indian Type Foundry', license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Rajdhani',
  },
];
