// A grenade in first person, thrown by an authored animation: DJMaesen's "Arms throwing" (the
// maker of the arms that hold our pistols, snipers and knife, in the same gloves and sleeves),
// with the grenade in the right hand.
//
// The pack is one throw, 0.67 s: the arm goes up and back over the shoulder, comes over and
// forward fast, holds the follow-through and comes back. It is played, not posed: pressing a
// button winds up to the top of the back-swing and holds there (pin out); letting go plays the
// rest, and the grenade leaves the hand at the frame where the hand moves fastest, which is when
// the sim lets it go (NADE_LEAVE). The draw raises the arms from below the picture.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { PACKS, type WeaponFiles } from './assets';
import { NADE_LEAVE } from '../sim/grenades';

export interface NadeViewState {
  /** 1 = just started drawing .. 0 = ready */
  drawT: number;
  /** seconds since the pin was pulled (<0: not) and since the throw began (<0: not) */
  pinT: number;
  throwT: number;
  /** 1 overarm, 0.5 both buttons, 0 underarm */
  str: number;
}

/** Moments of the pack's throw (seconds into its clip): the back-swing held while cooking, and the release. */
const WIND = 0.08;
const LEAVES = WIND + NADE_LEAVE;
/** How long the wind-up takes when the pin is pulled. */
const WIND_UP = 0.22;
/** How far below the picture the arms are before the draw (metres). */
const DRAW_DROP = 0.32;
/** How the grenade stands in the picture at the start of the throw (eye space: top leaning in toward the middle), and how far into the palm from the grip's middle it sits (0..1 toward the knuckles). */
const SEAT_TURN = new THREE.Euler(0.12, 0, 0.35);
const SEAT_IN = 0.15;
/** Where up its height each is held (0 the base .. 1 the top): a grenade round its middle, a bottle by the neck. */
const GRIP_AT: Record<string, number> = { molotov: 0.74 };

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class NadeRig {
  /** Eye space: x right, y up, -z ahead, metres. */
  readonly root = new THREE.Group();
  private arms: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private clip: THREE.AnimationClip;
  private ready = false;
  /** The grenade, its pin with the ring, and its lever (where the model has them as pieces). */
  private nade = new THREE.Group();
  private pin: THREE.Object3D[] = [];
  private lever: THREE.Object3D | null = null;
  private leverParent: THREE.Object3D | null = null;
  private pinHome = new THREE.Group();
  private leverHome = new THREE.Matrix4();
  private pinHomes: THREE.Matrix4[] = [];
  private fly: { o: THREE.Object3D; t: number; pos: THREE.Vector3; vel: THREE.Vector3; spin: number }[] = [];
  /** The clip time shown, eased toward the wanted one outside a throw. */
  private shown = 0;
  private first = true;

  /**
   * @param files the throwing pack, with the pack whose arm textures it borrows, and the grenade's model as its "gun"
   * @param dress gives the arm meshes their finish and the grenade's meshes theirs
   */
  constructor(id: string, files: WeaponFiles, dress: (arms: THREE.SkinnedMesh[], nade: THREE.Mesh[], borrowed: THREE.Material | null) => void) {
    const info = PACKS['throw']!;
    this.arms = SkeletonUtils.clone(files.pack.scene);
    const skinned: THREE.SkinnedMesh[] = [];
    this.arms.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      if (mesh.isSkinnedMesh) skinned.push(mesh);
    });
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.makeTranslation(info.hold[0], info.hold[1], info.hold[2]).multiply(new THREE.Matrix4().fromArray(info.view));
    holder.add(this.arms);
    this.root.add(holder);
    this.clip = files.pack.animations[0]!;
    this.mixer = new THREE.AnimationMixer(this.arms);
    this.mixer.clipAction(this.clip).play();
    this.mixer.setTime(0);

    const bone = (name: string): THREE.Object3D | null => {
      let f: THREE.Object3D | null = null;
      this.arms.traverse((o) => { if (!f && o.name === name) f = o; });
      return f;
    };
    const wrist = bone('R_wrist');

    // ---- the grenade, in the right hand ------------------------------------------------------
    const model = files.gun?.scene.clone(true) ?? new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      meshes.push(mesh);
    });
    // The frag's pieces: the pin runs through the fuse, the ring is flat, the lever lies down the side.
    for (const m of meshes) {
      const n = m.name.replace(/_\d+$/, '');
      if (/frag_grenade_[34]$/.test(m.name) || /^(pin|ring)$/.test(n)) this.pin.push(m);
      else if (/frag_grenade_2$/.test(m.name) || n === 'lever') this.lever = m;
    }
    // (stood about the height it is held at: a grenade's middle, a bottle's neck)
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model);
    const held = size.getCenter(new THREE.Vector3());
    held.y = size.min.y + (size.max.y - size.min.y) * (GRIP_AT[id] ?? 0.5);
    model.position.sub(held);
    this.nade.add(model);
    const thumb = bone('R_thumb4') ?? bone('R_thumb3'), middle = bone('R_middle2'), knuckle = bone('R_middle1');
    if (wrist && thumb && middle && knuckle) {
      // Seated in the grip the hand closes into at the start of the throw: between the tip of the
      // thumb and the middle finger, drawn a little in toward the knuckles.
      this.root.updateMatrixWorld(true);
      const w = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
      const grip = w(thumb).lerp(w(middle), 0.5).lerp(w(knuckle), SEAT_IN);
      wrist.add(this.nade);
      this.nade.position.copy(wrist.worldToLocal(grip));
      // (the pack is in centimetres: the grenade, in metres, is scaled up to match)
      this.nade.scale.setScalar(100);
      // Stood up in the picture as the hand holds it at rest; from there it turns with the hand.
      const wq = wrist.getWorldQuaternion(new THREE.Quaternion());
      const rq = this.root.getWorldQuaternion(new THREE.Quaternion());
      this.nade.quaternion.copy(wq.invert()).multiply(rq).multiply(new THREE.Quaternion().setFromEuler(SEAT_TURN));
      this.ready = true;
    }
    for (const p of this.pin) {
      this.pinHome.add(p);
      this.pinHomes.push(p.matrix.clone());
    }
    model.add(this.pinHome);
    if (this.lever) {
      this.lever.updateMatrix();
      this.leverHome.copy(this.lever.matrix);
      this.leverParent = this.lever.parent;
    }

    // The arm textures this pack borrows (it came without its own).
    let borrowed: THREE.Material | null = null;
    files.arms?.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && /^arms?$/i.test(m.name) && (m as THREE.MeshStandardMaterial).map) borrowed = m;
    });
    dress(skinned, meshes, borrowed);
    if (!this.ready) console.warn('grenade arms: no right wrist in the throwing pack');
  }

  get ok(): boolean {
    return this.ready;
  }

  /** Put the pin and lever back and the grenade in the hand (for the next one). */
  reset(): void {
    this.fly.length = 0;
    this.pin.forEach((p, i) => {
      this.pinHome.add(p);
      p.matrix.copy(this.pinHomes[i]!);
      p.matrix.decompose(p.position, p.quaternion, p.scale);
      p.visible = true;
    });
    this.nade.visible = true;
    if (this.lever) {
      this.leverParent?.add(this.lever);
      this.lever.matrix.copy(this.leverHome);
      this.lever.matrix.decompose(this.lever.position, this.lever.quaternion, this.lever.scale);
      this.lever.visible = true;
    }
  }

  /** Let a piece go: it keeps its place in the picture and falls away from there. */
  private release(o: THREE.Object3D, vx: number, vy: number, vz: number, spin: number): void {
    this.root.updateMatrixWorld(true);
    this.root.attach(o);
    this.fly.push({ o, t: 0, pos: o.position.clone(), vel: new THREE.Vector3(vx, vy, vz), spin });
  }

  /** Pose for this frame. */
  update(dt: number, st: NadeViewState): void {
    if (!this.ready) return;
    // ---- where in the throw ------------------------------------------------------------------
    let want = 0;
    if (st.throwT >= 0) want = Math.min(this.clip.duration - 1e-3, WIND + st.throwT);
    else if (st.pinT >= 0) want = WIND * ease(st.pinT / WIND_UP);
    // (snapped through the throw, where the timing is the point; eased back after it)
    const k = this.first || st.throwT >= 0 || st.pinT >= 0 ? 1 : Math.min(1, dt * 10);
    this.first = false;
    this.shown += (want - this.shown) * k;
    this.mixer.setTime(this.shown);
    // The draw raises the arms from below the picture.
    this.root.position.y = -DRAW_DROP * (1 - ease(1 - st.drawT));

    // ---- the pin: pulled with the press and flicked away -------------------------------------
    const pinned = this.pin[0]?.parent === this.pinHome;
    if (st.pinT >= 0.05 && pinned) for (const p of this.pin) this.release(p, -0.5, 0.6, 0.2, 9);
    else if (st.pinT < 0 && st.throwT < 0 && (!pinned || !this.nade.visible)) this.reset();

    // ---- the release: the grenade is gone (the sim's own is flying), the lever springs off ---
    const gone = st.throwT >= 0 && this.shown >= LEAVES;
    if (gone && this.nade.visible) {
      this.nade.visible = false;
      if (this.lever) this.release(this.lever, 0.7, 1.3, 0.2, 18);
    }

    for (let i = this.fly.length - 1; i >= 0; i--) {
      const f = this.fly[i]!;
      f.t += dt;
      f.vel.y -= 6 * dt;
      f.pos.addScaledVector(f.vel, dt);
      f.o.position.copy(f.pos);
      f.o.rotation.z += f.spin * dt;
      f.o.visible = f.t < 0.5;
      if (f.t >= 0.5) this.fly.splice(i, 1);
    }
  }
}
