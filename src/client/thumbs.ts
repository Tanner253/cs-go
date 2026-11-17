// Icons of the guns for the armory: plain white line drawings, in profile, made once each
// from the models other players see. The model is drawn off screen with its surface
// directions as colours; the icon is the lines where its outline and its hard edges are.

import * as THREE from 'three';
import { WEAPONS } from '../sim/weapons';
import { WEAPON_LOOK, getCharacters } from './assets';

const W = 384, H = 192;
/** Drawn this many times larger and shrunk, which smooths the lines. */
const SS = 3;
/** How different two neighbouring surface directions must be to count as an edge (0..765). */
const CREASE = 96;

export class Thumbs {
  private done = new Map<string, string>();
  private target: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.01, 20);
  private pivot = new THREE.Group();
  private paint = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  private failed = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.scene.add(this.pivot);
  }

  /** The icon of a weapon as an image URL, or '' while it has not been drawn yet. */
  get(id: string): string {
    return this.done.get(id) ?? '';
  }

  /** Draw at most one more icon. Call once a frame; returns true when one was added. */
  step(): boolean {
    if (this.failed) return false;
    const assets = getCharacters();
    if (!assets) return false;
    for (const [id, look] of Object.entries(WEAPON_LOOK)) {
      if (this.done.has(id) || id === 'edge') continue;
      const gun = assets.guns.get(look.world);
      if (!gun) continue;
      try {
        this.done.set(id, this.draw(gun.scene, gun.hide ?? [], WEAPONS[id]?.suppressor?.fitted === true));
      } catch (err) {
        console.warn('weapon icons unavailable', err);
        this.failed = true;
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * @param hide pieces of the model that are not fitted
   * @param comes the gun comes with its suppressor on
   */
  private draw(model: THREE.Object3D, hide: string[], comes: boolean): string {
    const left = new Set(hide);
    const obj = model.clone(true);
    obj.traverse((o) => {
      // Optional attachments are stored in these files but not fitted; a suppressor is drawn on the gun that comes with one.
      const piece = o.name.replace(/_\d+$/, '');
      if (/^(foregrip|light)$/.test(piece) || left.has(piece) || (piece === 'silencer' && !comes)) o.visible = false;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = this.paint;
    });

    // In profile, in the middle of the frame, as large as fits.
    this.pivot.add(obj);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.pivot);
    const mid = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const halfW = Math.max(size.x / 2, (size.y / 2) * (W / H)) * 1.08;
    this.cam.left = mid.x - halfW;
    this.cam.right = mid.x + halfW;
    this.cam.top = mid.y + halfW * (H / W);
    this.cam.bottom = mid.y - halfW * (H / W);
    this.cam.position.set(0, 0, box.max.z + 2);
    this.cam.far = size.z + 6;
    this.cam.updateProjectionMatrix();

    const w = W * SS, h = H * SS;
    const r = this.renderer;
    this.target ??= new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    const before = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    const px = new Uint8Array(w * h * 4);
    try {
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.scene, this.cam);
      r.readRenderTargetPixels(this.target, 0, 0, w, h, px);
    } finally {
      r.setRenderTarget(before);
      r.setClearColor(clear, alpha);
      this.pivot.remove(obj);
    }

    // Where the picture goes from gun to nothing: the outline. Where the surface turns sharply: an edge.
    const outline = new Uint8Array(w * h), edge = new Uint8Array(w * h);
    const inside = (i: number): boolean => px[i * 4 + 3]! > 127;
    const turn = (i: number, j: number): number =>
      Math.abs(px[i * 4]! - px[j * 4]!) + Math.abs(px[i * 4 + 1]! - px[j * 4 + 1]!) + Math.abs(px[i * 4 + 2]! - px[j * 4 + 2]!);
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x, right = i + 1, up = i + w;
        const a = inside(i);
        if (a !== inside(right) || a !== inside(up)) outline[i] = 1;
        else if (a && (turn(i, right) > CREASE || turn(i, up) > CREASE)) edge[i] = 1;
      }
    }
    // Thicken to pen width, then lay it down: outline in full, inner edges fainter, a breath of fill.
    const ink = new Uint8Array(w * h);
    const pen = (mask: Uint8Array, reach: number, value: number): void => {
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const x = i % w, y = (i - x) / w;
        for (let dy = -reach; dy <= reach; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w || dx * dx + dy * dy > reach * reach + 1) continue;
            const j = yy * w + xx;
            if (ink[j]! < value) ink[j] = value;
          }
        }
      }
    };
    pen(edge, 1, 120);
    pen(outline, 2, 255);
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = ink[i] || (inside(i) ? 22 : 0);
        if (!a) continue;
        // (the picture was read bottom row first)
        const o = ((h - 1 - y) * w + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = a;
      }
    }
    const big = document.createElement('canvas');
    big.width = w;
    big.height = h;
    big.getContext('2d')!.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const og = out.getContext('2d')!;
    og.imageSmoothingQuality = 'high';
    og.drawImage(big, 0, 0, W, H);
    return out.toDataURL('image/png');
  }
}
