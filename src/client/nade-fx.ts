// Grenades in the world: the grenade itself in flight and lying where it stopped, the smoke
// cloud a smoke grenade puts up, and the fire a molotov or incendiary leaves burning.
//
// The smoke is a cluster of large soft billboards spread through the same ellipsoid the sim
// tests sight lines against (grenades.ts), so what hides a player on screen is what hides them
// from the server and the bots: thick in the middle (a line through it crosses half a dozen
// layers), thin and ragged at the edge, growing out over its first second, standing, and thinning
// away over its last three. Standing in it, the view is veiled grey (see `veil`).

import * as THREE from 'three';
import type { Sim } from '../sim/game';
import { NADES } from '../sim/weapons';
import { SMOKE_LIFT, SMOKE_RH, SMOKE_RV, SMOKE_GROW, smokeAmount } from '../sim/grenades';
import { TICK, type Grenade } from '../sim/types';
import { WEAPON_LOOK, getCharacters, nadeMaterial } from './assets';
import type { Effects } from './effects';
import type { GameAudio } from './audio';
import type { Blasts } from './blast';

const PUFFS = 44;
const FIRE_LIGHTS = 2;

/** A soft, lumpy round of smoke for the billboards (drawn once). */
function puffTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  // A few octaves of value noise, shaped by a round falloff.
  let seed = 7;
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const grids = [4, 8, 16].map((n) => ({ n, v: Array.from({ length: (n + 1) * (n + 1) }, rnd) }));
  const at = (gr: { n: number; v: number[] }, u: number, w: number): number => {
    const x = u * gr.n, y = w * gr.n, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const v = (a: number, b: number): number => gr.v[Math.min(gr.n, b) * (gr.n + 1) + Math.min(gr.n, a)]!;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (v(i, j) * (1 - sx) + v(i + 1, j) * sx) * (1 - sy) + (v(i, j + 1) * (1 - sx) + v(i + 1, j + 1) * sx) * sy;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / (S - 1), w = y / (S - 1);
      const r = Math.hypot(u - 0.5, w - 0.5) * 2;
      const n = at(grids[0]!, u, w) * 0.55 + at(grids[1]!, u, w) * 0.3 + at(grids[2]!, u, w) * 0.15;
      const fall = Math.max(0, 1 - r);
      const a = Math.max(0, Math.min(1, (fall * fall * (3 - 2 * fall)) * (0.55 + n * 0.9) - 0.08));
      const k = (y * S + x) * 4;
      // (lighter on top, as if lit from above)
      const lit = 200 + 55 * (1 - w) * n;
      img.data[k] = lit; img.data[k + 1] = lit; img.data[k + 2] = lit; img.data[k + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A warm round glow for the ground under a fire. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,190,110,1)');
  grad.addColorStop(0.5, 'rgba(255,120,40,0.55)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

interface Puff { sprite: THREE.Sprite; at: THREE.Vector3; size: number; spin: number; shade: number }
interface Item {
  g: Grenade;
  model: THREE.Object3D | null;
  shown: THREE.Vector3;
  spin: THREE.Vector3;
  puffs: Puff[] | null;
  glow: THREE.Mesh | null;
  light: THREE.PointLight | null;
  emitAcc: number;
}

const _v = new THREE.Vector3();

export class NadeFx {
  readonly group = new THREE.Group();
  private items = new Map<number, Item>();
  private puffMap = puffTexture();
  private glowMap = glowTexture();
  private lights: THREE.PointLight[] = [];

  /** Where a fire's flames are drawn: the fire photographs of the explosions (see blast.ts), once the level is up. */
  blasts: Blasts | null = null;

  constructor(private fx: Effects, private audio: GameAudio) {
    // (a fixed number of lights keeps the shaders from being rebuilt as fires come and go)
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 9, 2);
      this.group.add(l);
      this.lights.push(l);
    }
  }

  private model(g: Grenade): THREE.Object3D | null {
    const id = NADES[g.kind]!.id;
    const key = WEAPON_LOOK[id]?.world ?? id;
    const gun = getCharacters()?.guns.get(key);
    if (!gun) return null;
    const o = gun.scene.clone(true);
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = nadeMaterial(mesh.material as THREE.Material, id);
      mesh.castShadow = false;
    });
    // (about its own middle, so it tumbles about it)
    const holder = new THREE.Group();
    const box = new THREE.Box3().setFromObject(o);
    o.position.sub(box.getCenter(_v));
    holder.add(o);
    return holder;
  }

  private cloud(item: Item): Puff[] {
    const puffs: Puff[] = [];
    let seed = item.g.id * 7919;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < PUFFS; i++) {
      // Spread through the ellipsoid, more of them towards the middle; the lower ones darker.
      const r = Math.pow(rnd(), 0.7), a = rnd() * Math.PI * 2, e = Math.acos(rnd() * 2 - 1);
      const at = new THREE.Vector3(Math.sin(e) * Math.cos(a) * r * SMOKE_RH * 0.86, Math.cos(e) * r * SMOKE_RV * 0.8, Math.sin(e) * Math.sin(a) * r * SMOKE_RH * 0.86);
      const shade = 0.17 + 0.05 * (at.y / SMOKE_RV) + rnd() * 0.03;
      const mat = new THREE.SpriteMaterial({ map: this.puffMap, transparent: true, depthWrite: false, color: new THREE.Color(shade, shade * 1.06, shade * 1.2) });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 4;
      this.group.add(sprite);
      puffs.push({ sprite, at, size: 2.5 + rnd() * 1.6, spin: (rnd() - 0.5) * 0.15, shade });
    }
    return puffs;
  }

  private drop(item: Item): void {
    if (item.model) this.group.remove(item.model);
    for (const p of item.puffs ?? []) { this.group.remove(p.sprite); p.sprite.material.dispose(); }
    if (item.glow) this.group.remove(item.glow);
    if (item.light) item.light.intensity = 0;
    this.audio.stopLoop(item.g.id);
  }

  clear(): void {
    for (const item of this.items.values()) this.drop(item);
    this.items.clear();
  }

  /**
   * Bring the picture in line with the sim's grenades.
   * @returns how far the camera is inside a smoke cloud (0 = clear .. 1 = deep in it)
   */
  update(sim: Sim, dt: number, alpha: number, cam: THREE.Vector3): number {
    const now = sim.time;
    const live = new Set<number>();
    let veil = 0;
    for (const g of sim.grenades) {
      if (g.state === 3) continue;
      live.add(g.id);
      let item = this.items.get(g.id);
      if (!item) {
        item = { g, model: null, shown: new THREE.Vector3(g.pos.x, g.pos.y, g.pos.z), spin: new THREE.Vector3(), puffs: null, glow: null, light: null, emitAcc: 0 };
        this.items.set(g.id, item);
      }
      item.g = g;
      const type = NADES[g.kind]!.nade!.type;
      // ---- the grenade itself (a fire's bottle is gone once it has burst) ----
      if (!item.model) {
        item.model = this.model(g);
        if (item.model) this.group.add(item.model);
      }
      if (item.model) {
        const flying = g.state === 0;
        // (drawn between ticks along its flight)
        _v.set(g.pos.x + g.vel.x * (alpha - 1) * TICK, g.pos.y + g.vel.y * (alpha - 1) * TICK, g.pos.z + g.vel.z * (alpha - 1) * TICK);
        if (_v.distanceTo(item.shown) > 2) item.shown.copy(_v);
        else item.shown.lerp(_v, Math.min(1, dt * 30));
        item.model.position.copy(item.shown);
        item.model.position.y += 0.035;
        if (flying) {
          // Tumbling end over end as it flies, slowing as it does.
          const sp = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
          item.spin.x += sp * 0.9 * dt;
          item.spin.z += sp * 0.35 * dt;
        } else if (g.state === 1 || g.state === 2) {
          // Lying on its side.
          item.spin.x += (Math.PI / 2 - (item.spin.x % Math.PI)) * Math.min(1, dt * 10);
        }
        item.model.rotation.set(item.spin.x, Math.atan2(g.vel.x, g.vel.z), item.spin.z);
        item.model.visible = !(type === 'fire' && g.state === 2);
        // A molotov's rag burns as it flies.
        if (type === 'fire' && g.state < 2 && NADES[g.kind]!.id === 'molotov') {
          item.emitAcc += dt * 45;
          while (item.emitAcc >= 1) { item.emitAcc--; this.fx.flame(item.shown.x, item.shown.y + 0.15, item.shown.z, 0.5); }
        }
      }
      // ---- smoke ----
      if (type === 'smoke' && g.state === 2) {
        if (!item.puffs) item.puffs = this.cloud(item);
        const k = smokeAmount(g, now);
        const age = now - g.popAt;
        const grow = 0.35 + 0.65 * Math.min(1, age / SMOKE_GROW);
        const cx = g.pos.x, cy = g.pos.y + SMOKE_LIFT, cz = g.pos.z;
        for (const p of item.puffs) {
          // (rising and spreading a little as it ages)
          const drift = 1 + Math.min(0.12, age * 0.008);
          p.sprite.position.set(cx + p.at.x * grow * drift, cy + p.at.y * grow + age * 0.012, cz + p.at.z * grow * drift);
          const s = p.size * (0.55 + 0.45 * grow);
          p.sprite.scale.set(s, s, 1);
          p.sprite.material.rotation += p.spin * dt;
          p.sprite.material.opacity = 0.93 * Math.min(1, k * 1.15);
        }
        // How deep the camera is in it.
        const dx = (cam.x - cx) / (SMOKE_RH * grow), dy = (cam.y - cy) / (SMOKE_RV * grow), dz = (cam.z - cz) / (SMOKE_RH * grow);
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        veil = Math.max(veil, Math.min(1, Math.max(0, (1.05 - d) * 2.2)) * k);
      }
      // ---- fire ----
      if (type === 'fire' && g.state === 2) {
        const r = sim.fireRadius(g);
        if (!item.glow) {
          item.glow = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ map: this.glowMap, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
          item.glow.renderOrder = 3;
          this.group.add(item.glow);
          item.light = this.lights.find((l) => l.intensity === 0) ?? null;
          this.audio.loop(g.id, 'nade.fire', g.pos.x, g.pos.y + 0.3, g.pos.z);
        }
        const left = g.endAt - now;
        const fade = Math.min(1, left / 0.8);
        const flicker = 0.8 + 0.2 * Math.sin(now * 23 + g.id) * Math.sin(now * 7.3);
        item.glow.position.set(g.pos.x, g.pos.y + 0.03, g.pos.z);
        item.glow.scale.setScalar(r * 1.25);
        (item.glow.material as THREE.MeshBasicMaterial).opacity = 0.55 * flicker * fade;
        if (item.light) {
          item.light.position.set(g.pos.x, g.pos.y + 0.8, g.pos.z);
          item.light.intensity = 7 * flicker * fade;
        }
        // Flames over the whole patch, thickest in the middle; smoke going up off it.
        item.emitAcc += dt * (this.blasts ? 58 : 110) * fade;
        while (item.emitAcc >= 1) {
          item.emitAcc--;
          const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 0.95;
          const x = g.pos.x + Math.cos(a) * d, z = g.pos.z + Math.sin(a) * d, k = 1.2 - (d / r) * 0.5;
          if (this.blasts) this.blasts.flame(x, g.pos.y, z, k);
          else this.fx.flame(x, g.pos.y + 0.05, z, k);
          if (Math.random() < 0.15) this.fx.fireSmoke(x, g.pos.y + 0.9, z);
        }
      }
    }
    for (const [id, item] of this.items) {
      if (live.has(id)) continue;
      this.drop(item);
      this.items.delete(id);
    }
    return veil;
  }
}
