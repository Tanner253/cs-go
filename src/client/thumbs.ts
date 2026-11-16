// Pictures of the guns for the armory, drawn once each from the models other players see,
// wearing their skins. They are rendered off screen at twice the size, tone-mapped here and
// kept as image URLs.

import * as THREE from 'three';
import { WEAPON_LOOK, getCharacters } from './assets';
import { WORLD_GUN_FINISH, applyFinish, roleOf, tagGunSpace, type Role } from './finish';
import { SKINS } from './skins';

const W = 384, H = 192, SS = 2;
const AT_REST = { heat: { value: 0 }, ammo: { value: 1 } };

/** The filmic curve the game's own final pass uses, so a picture matches the gun in hand. */
function aces(x: number): number {
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Thumbs {
  private done = new Map<string, string>();
  private target: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.01, 20);
  private pivot = new THREE.Group();
  private rim = new THREE.DirectionalLight(0xffffff, 2.2);
  private failed = false;

  /** @param environment the reflection map of the level, once there is one */
  constructor(private renderer: THREE.WebGLRenderer, private environment: () => THREE.Texture | null) {
    this.scene.add(new THREE.HemisphereLight(0xc6d8ff, 0x1c2028, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(-0.5, 1, 1);
    this.rim.position.set(0.6, 0.5, -1);
    this.scene.add(key, this.rim, this.pivot);
    // Seen from the side and a little from the front and above.
    this.pivot.rotation.set(0.16, -0.42, 0, 'YXZ');
    this.cam.position.set(0, 0, 5);
  }

  /** The picture of a weapon, or '' while it has not been drawn yet. */
  get(id: string): string {
    return this.done.get(id) ?? '';
  }

  /** Draw at most one more picture. Call once a frame; returns true when one was added. */
  step(): boolean {
    if (this.failed) return false;
    const assets = getCharacters();
    if (!assets) return false;
    for (const [id, look] of Object.entries(WEAPON_LOOK)) {
      if (this.done.has(id) || id === 'edge') continue;
      const gun = assets.guns.get(look.world);
      if (!gun) continue;
      try {
        this.done.set(id, this.draw(id, gun.scene));
      } catch (err) {
        console.warn('weapon pictures unavailable', err);
        this.failed = true;
        return false;
      }
      return true;
    }
    return false;
  }

  private draw(id: string, model: THREE.Object3D): string {
    const skin = SKINS[id];
    const obj = model.clone(true);
    obj.updateMatrixWorld(true);
    const made: THREE.Material[] = [];
    const parts: { mesh: THREE.Mesh; role: Role }[] = [];
    const gunBox = new THREE.Box3(), cellBox = new THREE.Box3();
    obj.traverse((o) => {
      if (/^(silencer|foregrip|light)(_\d+)?$/.test(o.name) && id !== 'osprey') o.visible = false;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !o.visible) return;
      const role = roleOf(mesh.name);
      parts.push({ mesh, role });
      tagGunSpace(mesh, mesh.matrixWorld, gunBox);
      if (role === 'cell') tagGunSpace(mesh, mesh.matrixWorld, cellBox);
    });
    const length = new THREE.Vector2(gunBox.min.x, gunBox.max.x);
    const cell = cellBox.isEmpty() ? new THREE.Vector2(0, 1) : new THREE.Vector2(cellBox.min.y, cellBox.max.y);
    for (const { mesh, role } of parts) {
      const wear = skin ? { skin, role, length, cell, ...AT_REST } : undefined;
      const m = applyFinish(mesh.material as THREE.Material, WORLD_GUN_FINISH, [mesh], wear);
      made.push(m);
      mesh.material = m;
    }

    // Stand it in the middle of the frame, as large as fits.
    this.pivot.add(obj);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.pivot);
    const mid = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const halfW = Math.max(size.x / 2, (size.y / 2) * (W / H)) * 1.06;
    this.cam.left = mid.x - halfW;
    this.cam.right = mid.x + halfW;
    this.cam.top = mid.y + halfW * (H / W);
    this.cam.bottom = mid.y - halfW * (H / W);
    this.cam.position.set(0, 0, box.max.z + 2);
    this.cam.far = size.z + 6;
    this.cam.updateProjectionMatrix();
    this.rim.color.set(skin?.glow ?? 0xffffff);
    this.scene.environment = this.environment();
    this.scene.environmentIntensity = 0.5;

    const r = this.renderer;
    this.target ??= new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true });
    const before = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    const px = new Uint16Array(W * SS * H * SS * 4);
    try {
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.scene, this.cam);
      r.readRenderTargetPixels(this.target, 0, 0, W * SS, H * SS, px);
    } finally {
      r.setRenderTarget(before);
      r.setClearColor(clear, alpha);
      this.pivot.remove(obj);
      for (const m of made) m.dispose();
    }

    // Linear light to a picture: tone-map, encode, flip the right way up.
    const big = document.createElement('canvas');
    big.width = W * SS;
    big.height = H * SS;
    const g = big.getContext('2d')!;
    const img = g.createImageData(W * SS, H * SS);
    const half = THREE.DataUtils.fromHalfFloat;
    for (let y = 0; y < H * SS; y++) {
      const src = (H * SS - 1 - y) * W * SS * 4, dst = y * W * SS * 4;
      for (let x = 0; x < W * SS * 4; x += 4) {
        const a = half(px[src + x + 3]!);
        if (a <= 0) continue;
        for (let k = 0; k < 3; k++) img.data[dst + x + k] = Math.round(255 * aces(half(px[src + x + k]!) * 1.5) ** (1 / 2.2));
        img.data[dst + x + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    g.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const og = out.getContext('2d')!;
    og.imageSmoothingQuality = 'high';
    og.drawImage(big, 0, 0, W, H);
    return out.toDataURL('image/png');
  }
}
