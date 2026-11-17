// Convert an FBX (skinned arms with their animation) to a binary glTF the game loads.
//
//   node tools/convert-fbx.mjs <in.fbx> <out.glb> [clip name]
//
// Uses three's own FBXLoader and GLTFExporter, so the result is exactly what three would have
// read from the FBX. Textures are left out: the game gives arms its own finish (finish.ts), and
// a pack that needs a texture borrows one from another pack (PackInfo.armsFrom).

import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const [, , input, output, clipName = 'throw'] = process.argv;
if (!input || !output) {
  console.error('usage: node tools/convert-fbx.mjs <in.fbx> <out.glb> [clip name]');
  process.exit(1);
}

// No DOM here: textures are not wanted, so none is loaded.
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
// GLTFExporter assembles the binary through a FileReader.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); this.onload?.({ target: this }); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onloadend?.(); this.onload?.({ target: this });
    });
  }
};

const data = readFileSync(input);
const root = new FBXLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
root.traverse((o) => {
  if (!o.isMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const out = mats.map((m) => new THREE.MeshStandardMaterial({ name: m.name, color: 0xffffff, roughness: 0.8, metalness: 0 }));
  o.material = Array.isArray(o.material) ? out : out[0];
});
const clips = root.animations.map((c, i) => { c.name = root.animations.length === 1 ? clipName : `${clipName}${i}`; return c; });

const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: clips, onlyVisible: false });
writeFileSync(output, Buffer.from(glb));
let bones = 0;
root.traverse((o) => { if (o.isBone) bones++; });
console.log(`${output}: ${(glb.byteLength / 1024).toFixed(0)} KB, ${bones} joints, clips ${clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(', ')}`);
