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
    note: 'Rifle, arms and animation. Scaled to metres, animations joined into one clip, textures re-encoded, geometry compressed; recoloured for the second rifle.',
  },
  {
    title: 'SMG FPS Animations', author: 'Cransh', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/smg-fps-animations-ca37ea9148dc4fcc9cc632175d311b23',
    note: 'Submachine gun, arms and animation. Same processing as above.',
  },
  {
    title: 'animated pistol', author: 'DJMaesen', license: 'CC BY 4.0',
    url: 'https://skfb.ly/ooPqJ',
    note: 'Pistol, arms and animation; one long animation cut into movements; recoloured for the other two pistols.',
  },
  {
    title: 'sniper animated', author: 'DJMaesen', license: 'CC BY 4.0',
    url: 'https://sketchfab.com/3d-models/sniper-animated-b48999a250b2433da59f705c371a49b2',
    note: 'Sniper rifle, arms and animation; one long animation cut into movements.',
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
  {
    title: "Snake's Authentic Gun Sounds", author: 'Snake (F8 Studios)', license: 'Free to use',
    url: 'https://f8studios.itch.io/snakes-authentic-gun-sounds',
    note: 'Gunshot, bolt, magazine and slide recordings, cut and levelled.',
  },
  {
    title: 'The Free Firearm Sound Library', author: 'Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney', license: 'CC0 1.0',
    url: 'https://opengameart.org/content/the-free-firearm-sound-library',
    note: 'Gunshot and handling recordings, cut and levelled.',
  },
  {
    title: 'Impact Sounds / Digital Audio', author: 'Kenney', license: 'CC0 1.0',
    url: 'https://kenney.nl/assets/impact-sounds',
    note: 'Footsteps, impacts and the charge beep.',
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
