// A grenade in first person: our arms (the rifle and submachine-gun packs' own, Cransh's) with a
// grenade in the right hand, moved through a throw that is made here rather than read from a
// pack (no pack in the game has one).
//
// The hands are what is animated: each has a pose (where the middle of its palm is, how it is
// turned, how far its fingers close) and the moments of a throw are poses in time. A copy of
// our own hand and finger joints, stood where ours stand at rest, is moved to them, and our arms
// are posed after that copy by the same reaching and finger-laying used for the packs that came
// without arms (worn-arms.ts): the shoulder stays put, the elbow bends, the forearm twists.
//
// The throw, as Counter-Strike's reads: the grenade comes up in the right hand; on the press the
// left hand goes to it and draws the pin out by its ring, while the right hand goes back and up
// (overarm), or down (an underarm lob); on letting go the arm comes over and forward, the hand
// opens, the lever flies off, and both hands drop out of the picture before the next one comes up.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { PACKS, type WeaponFiles } from './assets';
import { WornArms } from './worn-arms';

type Side = 'L' | 'R';

/**
 * A hand's pose: where the middle of its palm is [x, y, z] (eye space: right, up, -ahead; metres),
 * how it is turned from the way it rests [x, y, z] (radians, about the palm, eye-space axes), and
 * how far its fingers are closed (0 as modelled, 1 round a grenade).
 */
export type HandPose = [x: number, y: number, z: number, rx: number, ry: number, rz: number, c: number];
interface Pose { r: HandPose; l: HandPose }

/** The moments of a throw. (Mutable so they can be tuned live from the console.) */
export const NADE_POSES: Record<string, Pose> = {
  // Down out of the picture: before the draw and after the throw.
  down: { r: [0.15, -0.4, -0.15, -0.9, 0, 0.3, 1], l: [-0.12, -0.4, -0.25, -0.6, 0, -0.3, 0.3] },
  // Held: the grenade low in the right of the picture, fuse up, the left hand down out of it.
  hold: { r: [0.11, -0.1, -0.26, 0, 0, 0.6, 1], l: [-0.15, -0.22, -0.25, 0, 0.3, 0, 0.3] },
  // The grenade brought in to the middle and the left hand up to it, first finger through the ring.
  reach: { r: [0.06, -0.09, -0.27, 0.1, 0.3, 0.6, 1], l: [0.025, -0.06, -0.275, 0.4, 0.6, 0.8, 0.7] },
  // The ring drawn out to the left and down.
  pulled: { r: [0.08, -0.09, -0.26, 0.1, 0.3, 0.6, 1], l: [-0.09, -0.11, -0.3, 0.2, 0.3, 0.4, 0.7] },
  // Overarm: wound back up in the top right, the left arm out ahead, pointing.
  over: { r: [0.125, -0.035, -0.22, 0.6, 0, 0.9, 1], l: [-0.08, -0.06, -0.42, 0.2, 0.3, 0, -0.1] },
  // Underarm: down and back at the hip.
  under: { r: [0.12, -0.2, -0.2, -0.6, 0, 0.6, 1], l: [-0.1, -0.12, -0.36, 0.2, 0.3, 0, 0.2] },
  // The release: overarm the hand comes over and down ahead, opening; underarm it swings forward and up.
  overGo: { r: [0.08, -0.14, -0.4, -0.6, 0, 0.3, -0.3], l: [-0.12, -0.22, -0.28, -0.2, 0.3, 0, 0.3] },
  underGo: { r: [0.08, -0.06, -0.4, 0.3, 0, 0.4, -0.3], l: [-0.12, -0.22, -0.28, -0.2, 0.3, 0, 0.3] },
};

/** Where a grenade sits in the right hand: from the middle of the palm (the hand's own space) and turned. */
const SEAT = new THREE.Vector3(-0.035, 0.005, -0.02);
const SEAT_TURN = new THREE.Euler(0, 0, 1.4);

/** Seconds: the pin's reach and draw (as long as the sim's PIN_TIME), and the parts of a throw. */
const REACH = 0.13, PULL = 0.3, COCK = 0.34;
const RELEASE = 0.11, LETGO = 0.06, DROP = 0.42;

export interface NadeViewState {
  /** 1 = just started drawing .. 0 = ready */
  drawT: number;
  /** seconds since the pin was pulled (<0: not) and since the grenade left the hand (<0: not) */
  pinT: number;
  throwT: number;
  /** 1 overarm, 0.5 both buttons, 0 underarm */
  str: number;
}

interface Hand {
  obj: THREE.Object3D;
  restQ: THREE.Quaternion;
  /** the middle of the palm, at rest (root space), and in the hand's own space */
  palm: THREE.Vector3;
  palmLocal: THREE.Vector3;
  fingers: { o: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3; k: number }[];
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const at = (o: THREE.Object3D, v: THREE.Vector3): THREE.Vector3 => v.setFromMatrixPosition(o.matrixWorld);
const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function mix(a: HandPose, b: HandPose, k: number, out: HandPose): HandPose {
  for (let i = 0; i < 7; i++) out[i] = a[i]! + (b[i]! - a[i]!) * k;
  return out;
}

export class NadeRig {
  /** Eye space: x right, y up, -z ahead, metres. */
  readonly root = new THREE.Group();
  private worn: WornArms | null = null;
  private hands: Record<Side, Hand> = {} as Record<Side, Hand>;
  /** The grenade, its pin with the ring, and its lever (where the model has them as pieces). */
  private nade = new THREE.Group();
  private pin: THREE.Object3D[] = [];
  private lever: THREE.Object3D | null = null;
  private leverParent: THREE.Object3D | null = null;
  private pinHome = new THREE.Group();
  private pinHand = new THREE.Group();
  private leverHome = new THREE.Matrix4();
  private leverFly = { on: false, t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: 0 };
  private shownR: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private shownL: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private wantR: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private wantL: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private tmpA: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private tmpB: HandPose = [0, 0, 0, 0, 0, 0, 0];
  private first = true;

  /**
   * @param files the submachine-gun pack (our arms) and the grenade's model as its "gun"
   * @param dress gives the arm meshes the suit's finish and the grenade's meshes theirs
   */
  constructor(files: WeaponFiles, dress: (arms: THREE.SkinnedMesh[], toGun: (m: THREE.Mesh) => THREE.Matrix4, nade: THREE.Mesh[]) => void) {
    const info = PACKS['smg']!;
    const arms = SkeletonUtils.clone(files.pack.scene);
    // (only the arms: the pack's own gun is left out)
    const drop: THREE.Object3D[] = [];
    const skinned: THREE.SkinnedMesh[] = [];
    arms.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      if (mesh.isSkinnedMesh && /^(arms?|hands?|gloves?|sleeves?)$/i.test((mesh.material as THREE.Material).name)) {
        skinned.push(mesh);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
      } else drop.push(mesh);
    });
    for (const o of drop) o.removeFromParent();
    const still = new THREE.AnimationMixer(arms);
    still.clipAction(files.pack.animations[0]!).play();
    still.setTime(0);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.makeTranslation(info.hold[0], info.hold[1], info.hold[2]).multiply(new THREE.Matrix4().fromArray(info.view));
    holder.add(arms);
    this.root.add(holder);
    this.root.updateMatrixWorld(true);

    // ---- a copy of our hands and fingers, by the names worn-arms.ts reads ------------------
    const mine = (re: RegExp): THREE.Object3D | null => {
      let f: THREE.Object3D | null = null;
      arms.traverse((o) => { if (!f && re.test(o.name)) f = o; });
      return f;
    };
    const vroot = new THREE.Group();
    this.root.add(vroot);
    const copy = (name: string, o: THREE.Object3D, parent: THREE.Object3D): THREE.Object3D => {
      const c = new THREE.Object3D();
      c.name = name;
      vroot.add(c);
      o.matrixWorld.decompose(c.position, c.quaternion, c.scale);
      // (the copy stands where ours does: in the root's space, then under its parent)
      c.applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert());
      c.updateMatrixWorld(true);
      parent.attach(c);
      return c;
    };
    let ok = true;
    for (const s of ['L', 'R'] as Side[]) {
      const l = s.toLowerCase();
      const upper = mine(new RegExp(`^UpArm_${s}_\\d`)), fore = mine(new RegExp(`^Forearm_${s}_\\d`)), hand = mine(new RegExp(`^Hand_${s}_\\d`));
      const chain = (from: number, n: number): (THREE.Object3D | null)[] =>
        Array.from({ length: n }, (_, k) => mine(new RegExp(`^Bone_${s}${String(from + k).padStart(3, '0')}_\\d+$`)));
      const thumb = chain(20, 3);
      const four = [4, 8, 12, 16].map((k) => chain(k, 4));
      if (!upper || !fore || !hand || [...thumb, ...four.flat()].some((o) => !o)) { ok = false; continue; }
      const thumbBase = at(thumb[0]!, new THREE.Vector3());
      four.sort((x, y) => at(x[1]!, _v).distanceTo(thumbBase) - at(y[1]!, _v2).distanceTo(thumbBase));
      copy(`upperarm_${l}`, upper, vroot);
      copy(`lowerarm_${l}`, fore, vroot);
      const h = copy(`hand_${l}`, hand, vroot);
      const fingers: Hand['fingers'] = [];
      // The breadth of the hand: the axis every finger closes about.
      const lat = at(four[0]![1]!, new THREE.Vector3()).sub(at(four[3]![1]!, _v)).normalize();
      ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
        let parent: THREE.Object3D = h;
        for (let k = 1; k <= 3; k++) {
          const c = copy(`${f}_0${k}_${l}`, four[i]![k]!, parent);
          fingers.push({ o: c, rest: c.quaternion.clone(), axis: new THREE.Vector3(), k: [1.25, 1.35, 0.9][k - 1]! });
          parent = c;
        }
      });
      let parent: THREE.Object3D = h;
      for (let k = 1; k <= 3; k++) {
        const c = copy(`thumb_0${k}_${l}`, thumb[k - 1]!, parent);
        fingers.push({ o: c, rest: c.quaternion.clone(), axis: new THREE.Vector3(), k: [0.25, 0.45, 0.45][k - 1]! });
        parent = c;
      }
      vroot.updateMatrixWorld(true);
      for (const f of fingers) {
        // (the breadth of the hand in the joint's own space)
        f.o.getWorldQuaternion(_q);
        f.axis.copy(lat).applyQuaternion(_q.invert()).normalize();
      }
      const palmW = at(hand, new THREE.Vector3()).lerp(at(four[1]![1]!, _v), 0.5);
      this.hands[s] = {
        obj: h, restQ: h.quaternion.clone(),
        palm: this.root.worldToLocal(palmW.clone()),
        palmLocal: h.worldToLocal(palmW.clone()),
        fingers,
      };
    }
    if (ok) {
      const worn = new WornArms(vroot, arms, this.root);
      if (worn.ok) this.worn = worn;
    }
    if (!this.worn) console.warn('grenade arms could not be rigged');

    // ---- the grenade, in the right palm ---------------------------------------------------
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
    // (stood about its own middle, so a tall grenade sits in the hand as a round one does)
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const mid = box.getCenter(new THREE.Vector3());
    model.position.sub(mid.sub(new THREE.Vector3(0, 0.045, 0)));
    this.nade.add(model);
    if (this.hands.R) {
      const R = this.hands.R;
      R.obj.add(this.nade);
      // (in the palm and turned upright in it: fuse up between thumb and fingers)
      this.nade.userData['seat'] = R.palmLocal.clone();
      this.seat(SEAT, SEAT_TURN);
    }
    for (const p of this.pin) this.pinHome.add(p);
    model.add(this.pinHome);
    if (this.hands.L) this.hands.L.obj.add(this.pinHand);
    if (this.lever) {
      this.lever.updateMatrix();
      this.leverHome.copy(this.lever.matrix);
      this.leverParent = this.lever.parent;
    }

    // (the suit's weave is laid out on the arms as modelled, in the pack's gun space, as for the guns)
    this.root.updateMatrixWorld(true);
    const packToGun = new THREE.Matrix4().fromArray(info.frame!);
    const fromScene = new THREE.Matrix4().copy(arms.matrixWorld).invert();
    dress(skinned, (m) => new THREE.Matrix4().copy(packToGun).multiply(fromScene).multiply(m.matrixWorld), meshes);
  }

  /** Where the grenade sits in the right palm: moved (the hand's own space) and turned. Set once from outside while tuning. */
  seat(move: THREE.Vector3, turn: THREE.Euler, size = 1): void {
    const s = (this.nade.userData['seat'] as THREE.Vector3 | undefined) ?? new THREE.Vector3();
    this.nade.position.copy(s).add(move);
    this.nade.rotation.copy(turn);
    this.nade.scale.setScalar(size);
  }

  get ok(): boolean {
    return this.worn !== null;
  }

  /** Put the pin back and the grenade in the hand (for the next one). */
  reset(): void {
    for (const p of this.pin) this.pinHome.add(p);
    this.pinHand.visible = true;
    this.nade.visible = true;
    if (this.lever) {
      this.leverParent?.add(this.lever);
      this.lever.matrix.copy(this.leverHome);
      this.lever.matrix.decompose(this.lever.position, this.lever.quaternion, this.lever.scale);
    }
    this.leverFly.on = false;
  }

  private target(st: NadeViewState): void {
    const P = NADE_POSES;
    const r = this.wantR, l = this.wantL;
    const cock = st.str >= 0.75 ? P['over']! : st.str <= 0.25 ? P['under']! : null;
    const cockPose = (out: Pose): Pose => {
      if (cock) return cock;
      // (both buttons: halfway between the two)
      mix(P['over']!.r, P['under']!.r, 0.5, this.tmpA);
      mix(P['over']!.l, P['under']!.l, 0.5, this.tmpB);
      out.r = this.tmpA; out.l = this.tmpB;
      return out;
    };
    if (st.throwT >= 0) {
      const t = st.throwT;
      const from = cockPose({ r: this.tmpA, l: this.tmpB });
      const go = st.str >= 0.5 ? P['overGo']! : P['underGo']!;
      if (t < RELEASE) {
        const k = ease(t / RELEASE);
        mix(from.r, go.r, k, r);
        mix(from.l, go.l, k, l);
      } else {
        const k = ease((t - RELEASE) / (DROP - RELEASE));
        mix(go.r, P['down']!.r, k, r);
        mix(go.l, P['down']!.l, k, l);
      }
      return;
    }
    if (st.drawT > 0) {
      const k = ease(1 - st.drawT);
      mix(P['down']!.r, P['hold']!.r, k, r);
      mix(P['down']!.l, P['hold']!.l, k, l);
      return;
    }
    if (st.pinT >= 0) {
      const t = st.pinT;
      // The right hand winds up as the pin comes out.
      const c = cockPose({ r: this.tmpA, l: this.tmpB });
      mix(P['hold']!.r, c.r, ease((t - 0.08) / COCK), r);
      if (t < REACH) mix(P['hold']!.l, P['reach']!.l, ease(t / REACH), l);
      else if (t < PULL) mix(P['reach']!.l, P['pulled']!.l, ease((t - REACH) / (PULL - REACH)), l);
      else mix(P['pulled']!.l, c.l, ease((t - PULL) / 0.25), l);
      return;
    }
    for (let i = 0; i < 7; i++) { r[i] = P['hold']!.r[i]!; l[i] = P['hold']!.l[i]!; }
  }

  private place(h: Hand, p: HandPose): void {
    _e.set(p[3], p[4], p[5], 'YXZ');
    const q = _q.setFromEuler(_e).multiply(h.restQ);
    h.obj.quaternion.copy(q);
    // (turned about the middle of the palm, which lands at its rest place moved by the pose)
    _v.set(p[0], p[1], p[2]);
    h.obj.position.copy(_v).sub(_v2.copy(h.palmLocal).applyQuaternion(q));
    // (closing is a turn the other way about the breadth of the hand)
    for (const f of h.fingers) f.o.quaternion.copy(f.rest).multiply(_q2.setFromAxisAngle(f.axis, -p[6] * f.k));
  }

  /** Pose for this frame. Call with the root's matrices current (the holder's springs applied). */
  update(dt: number, st: NadeViewState): void {
    if (!this.worn) return;
    this.target(st);
    // Snapped through the throw, where the timing is the point; eased everywhere else.
    const snap = this.first || st.throwT >= 0 || st.drawT > 0.98;
    const k = snap ? 1 : Math.min(1, dt * 22);
    this.first = false;
    for (let i = 0; i < 7; i++) {
      this.shownR[i]! += (this.wantR[i]! - this.shownR[i]!) * k;
      this.shownL[i]! += (this.wantL[i]! - this.shownL[i]!) * k;
    }
    this.place(this.hands.R, this.shownR);
    this.place(this.hands.L, this.shownL);

    // The pin: in the grenade until the left hand has hold of the ring, then in that hand.
    const pinOut = st.pinT >= REACH || st.throwT >= 0;
    if (pinOut && this.pin[0]?.parent === this.pinHome) {
      this.root.updateMatrixWorld(true);
      for (const p of this.pin) this.pinHand.attach(p);
    } else if (!pinOut && st.throwT < 0 && this.pin[0]?.parent !== this.pinHome) {
      this.reset();
    }
    // Dropped out of sight once the hand has thrown it away.
    this.pinHand.visible = !(st.throwT > RELEASE * 2 || st.pinT > PULL + 0.4);
    // The grenade leaves the hand at the release; its lever springs away.
    const gone = st.throwT >= LETGO;
    if (gone && this.nade.visible) {
      this.nade.visible = false;
      if (this.lever) {
        this.root.updateMatrixWorld(true);
        this.root.attach(this.lever);
        this.leverFly.on = true;
        this.leverFly.t = 0;
        this.leverFly.pos.copy(this.lever.position);
        this.leverFly.vel.set(0.6, 1.4, 0.3);
        this.leverFly.spin = 18;
      }
    } else if (!gone && st.throwT < 0 && !this.nade.visible) {
      this.reset();
    }
    if (this.leverFly.on && this.lever) {
      const f = this.leverFly;
      f.t += dt;
      f.vel.y -= 6 * dt;
      f.pos.addScaledVector(f.vel, dt);
      this.lever.position.copy(f.pos);
      this.lever.rotation.z += f.spin * dt;
      if (f.t > 0.5) { f.on = false; this.lever.visible = false; }
      else this.lever.visible = true;
    }
    this.root.updateMatrixWorld(true);
    this.worn.follow();
  }
}
