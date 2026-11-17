// Our own arms on a pack animated round somebody else's.
//
// Some packs carry a gun's own draw, reload, reload from empty and inspection, but were animated
// on another maker's skeleton and come without arms (the AKS-74U's, the MP7's, the Scorpion's,
// the double-barrel's). Their skeleton is played as it was animated and is never drawn; the
// arms the rifle and submachine-gun packs are drawn in (Cransh's) are posed after it every frame:
// - each hand turned as theirs is, the middle of our palm on the middle of theirs;
// - every finger joint laid along theirs (turned from where both stand at rest, never curled on
//   top of that);
// - the arm reaching the hand with our own two bones from our own shoulder, its elbow out to the
//   side ours stands out to at rest, the forearm's twist shared down its twist joints.

import * as THREE from 'three';

type Side = 'L' | 'R';

/** One of our joints driven by one of theirs: our turn (in the world) is theirs times `off`. */
interface Link {
  ours: THREE.Object3D;
  theirs: THREE.Object3D;
  off: THREE.Quaternion;
}

interface Limb {
  upper: THREE.Object3D;
  fore: THREE.Object3D;
  hand: THREE.Object3D;
  twist: { n: THREE.Object3D; w: number; q0: THREE.Quaternion }[];
  theirHand: THREE.Object3D;
  theirMiddle: THREE.Object3D;
  handLink: Link;
  fingers: Link[];
  /** at rest, in the space of the whole (`root`): the shoulder's own place, the two bones' lengths and turns */
  shoulder: THREE.Vector3;
  up: number;
  low: number;
  qU: THREE.Quaternion;
  qF: THREE.Quaternion;
  qH: THREE.Quaternion;
  /** at rest: which way each bone lies, the side the elbow bends to, and where the elbow stands off the line */
  dU: THREE.Vector3;
  dF: THREE.Vector3;
  n: THREE.Vector3;
  pole: THREE.Vector3;
  /** the middle of our palm, in our hand's own space */
  palm: THREE.Vector3;
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _w = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qr = new THREE.Quaternion();
const _qI = new THREE.Quaternion();

const at = (o: THREE.Object3D, v: THREE.Vector3): THREE.Vector3 => v.setFromMatrixPosition(o.matrixWorld);
const turnOf = (o: THREE.Object3D, q: THREE.Quaternion): THREE.Quaternion => {
  o.matrixWorld.decompose(_p, q, _s);
  return q;
};
/** The turn whose x lies along `dir` and whose y is as near `hint` as it can be. */
const basis = (dir: THREE.Vector3, hint: THREE.Vector3, q: THREE.Quaternion): THREE.Quaternion => {
  const x = _a.copy(dir).normalize();
  const y = _b.copy(hint).addScaledVector(x, -hint.dot(x)).normalize();
  const z = _c.crossVectors(x, y);
  return q.setFromRotationMatrix(_m.makeBasis(x, y, z));
};
/** Set a joint's turn in the world (its parent's matrix must be current), and bring its own matrix up to date. */
const setTurn = (o: THREE.Object3D, q: THREE.Quaternion): void => {
  o.quaternion.copy(turnOf(o.parent!, _q3).invert().multiply(q));
  o.updateWorldMatrix(false, false);
};
const setAt = (o: THREE.Object3D, v: THREE.Vector3): void => {
  o.position.copy(_e.copy(v).applyMatrix4(_m2.copy(o.parent!.matrixWorld).invert()));
  o.updateWorldMatrix(false, false);
};
/** The way a joint points: to its first child joint, or (a fingertip) on from the joint before it. */
const lies = (o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 => {
  const c = o.children.find((k) => !(k as THREE.Mesh).isMesh);
  return c ? at(c, out).sub(at(o, _w)) : at(o, out).sub(at(o.parent!, _w));
};

/** A node's name without the number the exporter put on its end (and without three.js's taking out of dots). */
const bare = (name: string): string => name.replace(/_\d+$/, '');

/**
 * Their joints, found by any of the ways the packs name them: Unreal's mannequin (hand_l,
 * index_01_l), Rigify (DEF-hand.L), numbers (hand_l, palm_2_l, finger_21_l) and plain words
 * (l_wrist, l_index_low).
 */
function theirLimb(named: Map<string, THREE.Object3D>, s: Side): {
  upper: THREE.Object3D; fore: THREE.Object3D; hand: THREE.Object3D; fingers: THREE.Object3D[][]; thumb: THREE.Object3D[];
} | null {
  const l = s.toLowerCase();
  const pick = (...names: string[]): THREE.Object3D | null => {
    for (const n of names) {
      const o = named.get(n);
      if (o) return o;
    }
    return null;
  };
  const upper = pick(`upperarm_${l}`, `DEF-upper_arm${s}`, `${l}_upperarm`);
  const fore = pick(`lowerarm_${l}`, `forearm_${l}`, `DEF-forearm${s}`, `${l}_forearm`);
  const hand = pick(`hand_${l}`, `DEF-hand${s}`, `${l}_wrist`);
  if (!upper || !fore || !hand) return null;
  const word = ['low', 'mid', 'tip'];
  const finger = (f: string): THREE.Object3D[] =>
    [1, 2, 3].map((k) => pick(`${f}_0${k}_${l}`, `DEF-f_${f}0${k}${s}`, `${l}_${f}_${word[k - 1]}`)).filter((o): o is THREE.Object3D => !!o);
  let fingers = ['index', 'middle', 'ring', 'pinky'].map(finger);
  let thumb = [1, 2, 3].map((k) => pick(`thumb_0${k}_${l}`, `DEF-thumb0${k}${s}`, `${l}_thumb_${word[k - 1]}`)).filter((o): o is THREE.Object3D => !!o);
  if (fingers.some((f) => f.length < 3)) {
    // Numbered: the thumb is the first (a palm joint and two), the rest are told apart by how
    // far their knuckles are from it.
    const thumbAt = named.get(`finger_11_${l}`);
    if (!thumbAt) return null;
    thumb = [`palm_1_${l}`, `finger_11_${l}`, `finger_12_${l}`].map((n) => named.get(n)).filter((o): o is THREE.Object3D => !!o);
    fingers = [2, 3, 4, 5].map((n) => [1, 2, 3].map((k) => named.get(`finger_${n}${k}_${l}`)).filter((o): o is THREE.Object3D => !!o));
    if (fingers.some((f) => f.length < 3)) return null;
    const base = at(thumbAt, new THREE.Vector3());
    fingers.sort((x, y) => at(x[0]!, _d).distanceTo(base) - at(y[0]!, _e).distanceTo(base));
  }
  return { upper, fore, hand, fingers, thumb };
}

export class WornArms {
  private limbs: Limb[] = [];

  /**
   * @param pack their skeleton, as it stands now (matrices current)
   * @param ours our arms' file's scene, cloned, laid in the same space as `pack`, and stood as they
   *   stand at rest (matrices current)
   * @param root what both are drawn under
   */
  constructor(pack: THREE.Object3D, ours: THREE.Object3D, private root: THREE.Object3D) {
    const named = new Map<string, THREE.Object3D>();
    pack.traverse((o) => {
      const n = bare(o.name);
      if (!named.has(n)) named.set(n, o);
    });
    const mine = (re: RegExp): THREE.Object3D | null => {
      let f: THREE.Object3D | null = null;
      ours.traverse((o) => { if (!f && re.test(o.name)) f = o; });
      return f;
    };
    root.updateMatrixWorld(true);
    const rootQ = turnOf(root, new THREE.Quaternion()).invert();
    const local = (v: THREE.Vector3): THREE.Vector3 => root.worldToLocal(v);
    const localTurn = (o: THREE.Object3D): THREE.Quaternion => turnOf(o, new THREE.Quaternion()).premultiply(rootQ);

    for (const s of ['L', 'R'] as Side[]) {
      const theirs = theirLimb(named, s);
      const upper = mine(new RegExp(`^UpArm_${s}_\\d`)), fore = mine(new RegExp(`^Forearm_${s}_\\d`)), hand = mine(new RegExp(`^Hand_${s}_\\d`));
      const wristEnd = mine(new RegExp(`^BoneTwist_01${s}_end`));
      if (!theirs || !upper || !fore || !hand || !wristEnd) continue;
      const chain = (from: number, n: number): (THREE.Object3D | null)[] =>
        Array.from({ length: n }, (_, k) => mine(new RegExp(`^Bone_${s}${String(from + k).padStart(3, '0')}_\\d+$`)));
      const thumb = chain(20, 3);
      const four = [4, 8, 12, 16].map((k) => chain(k, 4));
      if ([...thumb, ...four.flat()].some((o) => !o)) continue;
      const thumbBase = at(thumb[0]!, new THREE.Vector3());
      four.sort((x, y) => at(x[1]!, _d).distanceTo(thumbBase) - at(y[1]!, _e).distanceTo(thumbBase));

      // The hand's breadth (first finger's knuckle to the little one's), ours and theirs: the
      // second way every joint is laid by.
      const latO = at(four[0]![1]!, new THREE.Vector3()).sub(at(four[3]![1]!, _d));
      const latT = at(theirs.fingers[0]![0]!, new THREE.Vector3()).sub(at(theirs.fingers[3]![0]!, _d));
      const link = (o: THREE.Object3D, t: THREE.Object3D, dO: THREE.Vector3, dT: THREE.Vector3): Link => {
        // (ours laid along theirs where both stand now, then turned as theirs turns from there)
        const R = basis(dT, latT, new THREE.Quaternion()).multiply(basis(dO, latO, _q2).invert());
        const laid = R.multiply(turnOf(o, _q));
        return { ours: o, theirs: t, off: turnOf(t, new THREE.Quaternion()).invert().multiply(laid) };
      };
      const fingers: Link[] = [];
      four.forEach((f, k) => {
        // (their three joints of each finger against our last three; our knuckle's bone in the palm stays as it is)
        const t = theirs.fingers[k]!;
        for (let i = 0; i < 3; i++) fingers.push(link(f[i + 1]!, t[i]!, lies(f[i + 1]!, new THREE.Vector3()), lies(t[i]!, new THREE.Vector3())));
      });
      for (let i = 0; i < Math.min(3, theirs.thumb.length); i++) {
        fingers.push(link(thumb[i]!, theirs.thumb[i]!, lies(thumb[i]!, new THREE.Vector3()), lies(theirs.thumb[i]!, new THREE.Vector3())));
      }
      const theirMiddle = theirs.fingers[1]![0]!;
      const handLink = link(hand, theirs.hand,
        at(four[1]![1]!, new THREE.Vector3()).sub(at(hand, _d)),
        at(theirMiddle, new THREE.Vector3()).sub(at(theirs.hand, _d)));

      const S = local(at(upper, new THREE.Vector3())), E = local(at(fore, new THREE.Vector3())), W = local(at(wristEnd, new THREE.Vector3()));
      const n = new THREE.Vector3().crossVectors(_a.copy(W).sub(S), _b.copy(E).sub(S));
      if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
      const line = _c.copy(W).sub(S).normalize();
      const pole = E.clone().sub(S);
      pole.addScaledVector(line, -pole.dot(line)).normalize();
      const twist = [3, 2, 1].map((k) => mine(new RegExp(`^BoneTwist_0${k}${s}_\\d+$`))).filter((o): o is THREE.Object3D => !!o);
      this.limbs.push({
        upper, fore, hand,
        twist: twist.map((t, k) => ({ n: t, w: (k + 1) / twist.length, q0: localTurn(t) })),
        theirHand: theirs.hand, theirMiddle, handLink, fingers,
        shoulder: upper.position.clone(),
        up: E.distanceTo(S), low: W.distanceTo(E),
        qU: localTurn(upper), qF: localTurn(fore), qH: localTurn(hand),
        dU: E.clone().sub(S).normalize(), dF: W.clone().sub(E).normalize(), n: n.normalize(), pole,
        palm: hand.worldToLocal(at(hand, new THREE.Vector3()).lerp(at(four[1]![1]!, _d), 0.5)),
      });
    }
  }

  /** Whether both arms were matched to the pack's skeleton. */
  get ok(): boolean {
    return this.limbs.length === 2;
  }

  /** Ours posed after theirs as they stand this frame. Call once the frame's movement is set and the matrices are current. */
  follow(): void {
    const rootQ = turnOf(this.root, _qr);
    const toWorld = (v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => out.copy(v).applyQuaternion(rootQ);
    for (const a of this.limbs) {
      // The hand: turned as theirs is, the middle of the palm on the middle of theirs.
      const qH = turnOf(a.theirHand, new THREE.Quaternion()).multiply(a.handLink.off);
      setTurn(a.hand, qH);
      const theirPalm = at(a.theirHand, new THREE.Vector3()).lerp(at(a.theirMiddle, _d), 0.5);
      const ourPalm = _d.copy(a.palm).applyMatrix4(a.hand.matrixWorld);
      setAt(a.hand, at(a.hand, _w).add(theirPalm.sub(ourPalm)));
      // The fingers, joint after joint from the knuckle out.
      for (const f of a.fingers) setTurn(f.ours, turnOf(f.theirs, _q).multiply(f.off));
      a.hand.updateMatrixWorld(true);

      // The arm: from where the shoulder rests, brought forward only as far as an arm too short to reach needs.
      a.upper.position.copy(a.shoulder);
      a.upper.updateWorldMatrix(false, false);
      const S = at(a.upper, new THREE.Vector3()), W = at(a.hand, new THREE.Vector3());
      const reach = _c.copy(W).sub(S);
      const long = a.up + a.low - 1e-4, far = reach.length();
      if (far > long) {
        S.addScaledVector(reach.normalize(), far - long);
        setAt(a.upper, S);
        reach.copy(W).sub(S);
      }
      const d = THREE.MathUtils.clamp(reach.length(), Math.abs(a.up - a.low) + 1e-4, long);
      const r = reach.normalize();
      const along = (a.up * a.up - a.low * a.low + d * d) / (2 * d);
      const out = Math.sqrt(Math.max(0, a.up * a.up - along * along));
      const pole = toWorld(a.pole, new THREE.Vector3());
      pole.addScaledVector(r, -pole.dot(r)).normalize();
      const E = S.clone().addScaledVector(r, along).addScaledVector(pole, out);
      const n = new THREE.Vector3().crossVectors(_d.copy(W).sub(S), _e.copy(E).sub(S)).normalize();
      const n0 = toWorld(a.n, new THREE.Vector3());
      // (each bone turned from how it lies at rest to how it lies now, its bend kept to the side it bends to)
      const Ru = basis(_d.copy(E).sub(S), n, new THREE.Quaternion()).multiply(basis(toWorld(a.dU, _e), n0, _q2).invert());
      setTurn(a.upper, Ru.multiply(_q.copy(rootQ).multiply(a.qU)));
      a.fore.updateWorldMatrix(false, false);
      const Rf = basis(_d.copy(W).sub(E), n, new THREE.Quaternion()).multiply(basis(toWorld(a.dF, _e), n0, _q2).invert());
      const foreQ = new THREE.Quaternion().copy(rootQ).multiply(a.qF).premultiply(Rf);
      setTurn(a.fore, foreQ);
      // The forearm's twist: how far the hand is turned about the forearm past where the forearm alone has it.
      const rel = _q2.copy(qH).multiply(_q.copy(rootQ).multiply(a.qH).premultiply(Rf).invert());
      const axis = _w.copy(W).sub(E).normalize();
      const v = axis.multiplyScalar(rel.x * axis.x + rel.y * axis.y + rel.z * axis.z);
      const tw = new THREE.Quaternion(v.x, v.y, v.z, rel.w).normalize();
      for (const t of a.twist) {
        t.n.updateWorldMatrix(false, false);
        setTurn(t.n, _qI.identity().slerp(tw, t.w).multiply(_q.copy(rootQ).multiply(t.q0).premultiply(Rf)));
      }
      a.upper.updateMatrixWorld(true);
    }
  }
}
