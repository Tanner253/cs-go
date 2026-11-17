// The radar, as Counter-Strike's: centred on the player and turned with them (ahead is up),
// over an overview painted from the level itself: the floor anyone can stand on (from the
// bots' walking grid, so it is exactly the playable space), raised floors lighter, cover
// darker with a fine edge, covered stretches shaded, the sites lettered and the spawns marked.
// Teammates show with the way they face; an enemy shows while seen, and where they were last
// seen for a few seconds after, fading.

import type { Sim } from '../sim/game';
import { ATK, type Player } from '../sim/types';
import { eyeHeight } from '../sim/movement';
import { Mat } from '../sim/map';

/** Pixels per metre of the painted overview. */
const PPM = 12;
/** Metres from the centre of the radar to its edge. */
const RANGE = 23;
/** Seconds a last-seen enemy mark lasts. */
const LAST_SEEN = 3;
const SIDE_COLOR = ['#ff7a2e', '#35e0ff'];
const ENEMY = '#ff3b30';

export class Radar {
  private ctx: CanvasRenderingContext2D;
  private art: HTMLCanvasElement | null = null;
  private ox = 0;
  private oz = 0;
  private size = 0;
  private dpr = 1;
  private seenAt: number[] = [];
  private seenX: number[] = [];
  private seenZ: number[] = [];
  private labels: { text: string; x: number; z: number; color: string; big: boolean }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Paint the overview once: everything that never moves. */
  private paint(sim: Sim): void {
    const nav = sim.nav;
    const W = Math.ceil(nav.w * nav.cell * PPM), H = Math.ceil(nav.h * nav.cell * PPM);
    const art = document.createElement('canvas');
    art.width = W;
    art.height = H;
    const g = art.getContext('2d')!;
    this.ox = nav.ox;
    this.oz = nav.oz;
    const px = (x: number): number => (x - this.ox) * PPM;
    const pz = (z: number): number => (z - this.oz) * PPM;

    // The floor: each cell a player's middle can stand in, grown by the half-width of a body so
    // it meets the walls; the higher, the lighter.
    const c = nav.cell * PPM, grow = 0.45 * PPM;
    for (let i = 0; i < nav.w * nav.h; i++) {
      const y = nav.height[i]!;
      if (Number.isNaN(y)) continue;
      const lift = Math.max(0, Math.min(1, y / 1.2));
      const v = Math.round(58 + lift * 34);
      g.fillStyle = `rgb(${v - 6},${v},${v + 12})`;
      g.fillRect((i % nav.w) * c - grow, ((i / nav.w) | 0) * c - grow, c + grow * 2, c + grow * 2);
    }
    // Walls over it, so its edges are the walls' own.
    const walls = sim.map.boxes.filter((b) => !b.noCollide && !b.hidden && b.minY < 0.5 && b.maxY >= 2.4 && b.mat !== Mat.Floor);
    g.fillStyle = '#0b0e13';
    for (const b of walls) g.fillRect(px(b.minX), pz(b.minZ), (b.maxX - b.minX) * PPM, (b.maxZ - b.minZ) * PPM);
    // Cover a body can hide behind but see over from a step: darker, with a fine light edge.
    g.lineWidth = 1.5;
    for (const b of sim.map.boxes) {
      if (b.noCollide || b.hidden || b.minY > 0.5 || b.maxY < 0.9 || b.maxY >= 2.4 || (b.mat === Mat.Deck && b.maxY < 1)) continue;
      g.fillStyle = 'rgba(16,20,27,0.9)';
      g.fillRect(px(b.minX), pz(b.minZ), (b.maxX - b.minX) * PPM, (b.maxZ - b.minZ) * PPM);
      g.strokeStyle = 'rgba(170,186,206,0.55)';
      g.strokeRect(px(b.minX) + 0.75, pz(b.minZ) + 0.75, (b.maxX - b.minX) * PPM - 1.5, (b.maxZ - b.minZ) * PPM - 1.5);
    }
    // Roofed stretches: shaded, so a covered connector reads as one.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (const b of sim.map.boxes) {
      if (b.hidden || b.mat !== Mat.Roof || b.minY < 2.4) continue;
      g.fillRect(px(b.minX), pz(b.minZ), (b.maxX - b.minX) * PPM, (b.maxZ - b.minZ) * PPM);
    }
    // A fine light line round every wall, where the floor meets it.
    g.strokeStyle = 'rgba(190,205,225,0.35)';
    g.lineWidth = 1;
    for (const b of walls) g.strokeRect(px(b.minX) + 0.5, pz(b.minZ) + 0.5, (b.maxX - b.minX) * PPM - 1, (b.maxZ - b.minZ) * PPM - 1);
    // The sites: their ground tinted and edged.
    for (const site of sim.map.sites) {
      const z = site.zone;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(px(z.minX), pz(z.minZ), (z.maxX - z.minX) * PPM, (z.maxZ - z.minZ) * PPM);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.setLineDash([6, 4]);
      g.strokeRect(px(z.minX), pz(z.minZ), (z.maxX - z.minX) * PPM, (z.maxZ - z.minZ) * PPM);
      g.setLineDash([]);
    }
    this.art = art;
    // (letters are drawn upright each frame, at their turned place)
    this.labels = sim.map.sites.map((s) => ({ text: s.name, x: s.center.x, z: s.center.z, color: '#ffffff', big: true }));
    sim.map.buyZones.forEach((zone, team) => {
      this.labels.push({ text: team === ATK ? 'ATK' : 'DEF', x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2, color: SIDE_COLOR[team]!, big: false });
    });
  }

  draw(sim: Sim, view: Player, me: Player | null, now: number): void {
    if (!this.art) this.paint(sim);
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = cv.clientWidth || 200;
    if (css !== this.size || dpr !== this.dpr) {
      this.size = css;
      this.dpr = dpr;
      cv.width = cv.height = Math.round(css * dpr);
    }
    const g = this.ctx;
    const S = cv.width;
    const half = S / 2;
    const k = half / RANGE; // canvas px per metre
    const yaw = view.yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // World (x, z) to the radar: about the viewed player, turned so that ahead is up.
    const vx = view.pos.x, vz = view.pos.z;
    const toX = (x: number, z: number): number => half + ((x - vx) * cy - (z - vz) * sy) * k;
    const toY = (x: number, z: number): number => half + ((x - vx) * sy + (z - vz) * cy) * k;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(6,8,12,0.78)';
    g.fillRect(0, 0, S, S);
    // The overview, turned about the player.
    g.save();
    g.translate(half, half);
    g.rotate(yaw);
    g.scale(k / PPM, k / PPM);
    g.translate(-(vx - this.ox) * PPM, -(vz - this.oz) * PPM);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.art!, 0, 0);
    g.restore();

    // Labels, upright.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const l of this.labels) {
      const x = toX(l.x, l.z), y = toY(l.x, l.z);
      if (x < -20 || y < -20 || x > S + 20 || y > S + 20) continue;
      g.font = `700 ${Math.round((l.big ? 22 : 11) * dpr)}px Rajdhani, sans-serif`;
      g.fillStyle = l.color;
      g.globalAlpha = l.big ? 0.85 : 0.7;
      g.fillText(l.text, x, y);
    }
    g.globalAlpha = 1;

    // The field of view: a faint wedge ahead.
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.beginPath();
    g.moveTo(half, half);
    g.arc(half, half, S * 0.6, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    g.closePath();
    g.fill();

    const pov = me ?? view;
    const ey = view.pos.y + eyeHeight(view);
    const dot = 3.6 * dpr;
    for (const p of sim.players) {
      if (p === view) continue;
      const x = toX(p.pos.x, p.pos.z), y = toY(p.pos.x, p.pos.z);
      if (p.team === pov.team) {
        if (!p.alive) continue;
        // A teammate: their side's colour, with a tick the way they face.
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        const dx = (fx * cy - fz * sy), dy = (fx * sy + fz * cy);
        g.strokeStyle = SIDE_COLOR[p.team]!;
        g.lineWidth = 1.6 * dpr;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + dx * dot * 2.4, y + dy * dot * 2.4);
        g.stroke();
        g.fillStyle = SIDE_COLOR[p.team]!;
        g.beginPath();
        g.arc(x, y, dot, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 1 * dpr;
        g.stroke();
        continue;
      }
      // An enemy: shown while the player we look through can see them; where they were last
      // seen, a ring that fades.
      const seen = p.alive && view.alive && sim.world.lineOfSight(view.pos.x, ey, view.pos.z, p.pos.x, p.pos.y + 1.2, p.pos.z);
      if (seen) {
        this.seenAt[p.id] = now;
        this.seenX[p.id] = p.pos.x;
        this.seenZ[p.id] = p.pos.z;
        g.fillStyle = ENEMY;
        g.beginPath();
        g.arc(x, y, dot * 1.1, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 1 * dpr;
        g.stroke();
      } else if (p.alive && this.seenAt[p.id] !== undefined && now - this.seenAt[p.id]! < LAST_SEEN) {
        const fade = 1 - (now - this.seenAt[p.id]!) / LAST_SEEN;
        const lx = toX(this.seenX[p.id]!, this.seenZ[p.id]!), ly = toY(this.seenX[p.id]!, this.seenZ[p.id]!);
        g.globalAlpha = fade;
        g.strokeStyle = ENEMY;
        g.lineWidth = 1.6 * dpr;
        g.beginPath();
        g.arc(lx, ly, dot * 1.1, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // The charge.
    const ch = sim.charge;
    if (ch.state === 'planted' || (ch.state === 'dropped' && pov.team === ATK)) {
      const x = toX(ch.pos.x, ch.pos.z), y = toY(ch.pos.x, ch.pos.z);
      const r = 5.5 * dpr;
      g.fillStyle = ch.state === 'planted' && Math.floor(sim.time * 3) % 2 ? ENEMY : '#ffffff';
      g.beginPath();
      g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.lineWidth = 1 * dpr;
      g.stroke();
    }

    // The player: an arrow in the middle, always pointing up.
    if (view.alive) {
      const a = 7 * dpr;
      g.fillStyle = '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      g.moveTo(half, half - a); g.lineTo(half + a * 0.68, half + a * 0.75); g.lineTo(half, half + a * 0.35); g.lineTo(half - a * 0.68, half + a * 0.75);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }
}
