// Bot brains. A bot only produces an input command, exactly like a human, so it obeys the
// same movement, recoil and accuracy rules as everyone else.

import { angleDelta, clamp, forwardFromAngles, lerp, v3, wrapAngle, yawTo, type Vec3 } from './math';
import { eyeHeight } from './movement';
import { ATK, BTN_CROUCH, BTN_FIRE, BTN_JUMP, BTN_RELOAD, BTN_USE, DEF, type Cmd, type Player } from './types';
import type { Sim } from './game';

const f3 = v3();

export class Bot {
  /** Remaining high-level waypoints toward the objective. */
  route: Vec3[] = [];
  site = 0;
  holdPos: Vec3 | null = null;
  holdLook: Vec3 | null = null;
  /** Seconds after the round goes live before this bot starts moving. */
  startDelay = 0;

  private path: Vec3[] = [];
  private pathI = 0;
  private goal: Vec3 | null = null;
  private nextDecide = 0;
  private nextSense: number;

  private target = -1;
  private visible = false;
  private reactAt = 0;
  private lostAt = -99;
  private lastSeen = v3();
  private lastSeenAt = -99;

  private aimYaw = 0;
  private aimPitch = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errUntil = 0;

  private burstLeft = 0;
  private pauseUntil = 0;
  private fireHeld = false;
  private strafe = 0;
  private strafeUntil = 0;
  private crouchUntil = 0;

  private stuckX = 0;
  private stuckZ = 0;
  private stuckCheckAt = 0;
  private jumpAt = -1;
  private bought = false;
  private buyAt = 0;
  private wantsUse = false;
  private spot: Vec3 | null = null;
  private skill: number;

  constructor(readonly me: Player, private sim: Sim) {
    this.nextSense = (me.id % 6) / 64;
    this.skill = clamp(sim.botSkill + (sim.rng.next() - 0.5) * 0.25, 0, 1);
  }

  /** Called at the start of every round. */
  reset(): void {
    this.path = [];
    this.pathI = 0;
    this.goal = null;
    this.target = -1;
    this.visible = false;
    this.lastSeenAt = -99;
    this.nextDecide = 0;
    this.bought = false;
    this.buyAt = this.sim.time + 0.4 + this.sim.rng.next() * 2;
    this.aimYaw = this.me.yaw;
    this.aimPitch = 0;
    this.spot = null;
    this.wantsUse = false;
    this.burstLeft = 0;
    this.stuckCheckAt = 0;
    this.skill = clamp(this.sim.botSkill + (this.sim.rng.next() - 0.5) * 0.25, 0, 1);
  }

  private setGoal(g: Vec3 | null): void {
    if (g === this.goal) return;
    if (g && this.goal && Math.hypot(g.x - this.goal.x, g.z - this.goal.z) < 0.6) return;
    this.goal = g;
    this.path = [];
    this.pathI = 0;
    if (g) {
      const p = this.sim.nav.findPath(this.me.pos, g);
      if (p) this.path = p;
    }
  }

  private distTo(p: Vec3): number {
    return Math.hypot(p.x - this.me.pos.x, p.z - this.me.pos.z);
  }

  // ---- perception ------------------------------------------------------------------

  private canSee(e: Player): boolean {
    const me = this.me, w = this.sim.world;
    const ex = e.pos.x - me.pos.x, ez = e.pos.z - me.pos.z;
    const d = Math.hypot(ex, ez);
    if (d > 75) return false;
    if (d > 3.5) {
      const off = Math.abs(angleDelta(this.aimYaw, yawTo(me.pos.x, me.pos.z, e.pos.x, e.pos.z)));
      if (off > 1.05) return false; // ~120 degree field of view
    }
    const oy = me.pos.y + eyeHeight(me);
    return (
      w.lineOfSight(me.pos.x, oy, me.pos.z, e.pos.x, e.pos.y + eyeHeight(e), e.pos.z) ||
      w.lineOfSight(me.pos.x, oy, me.pos.z, e.pos.x, e.pos.y + 1.0, e.pos.z)
    );
  }

  private sense(): void {
    const sim = this.sim, me = this.me, now = sim.time;
    let best: Player | null = null;
    let bestD = Infinity;
    const cur = this.target >= 0 ? sim.players[this.target]! : null;
    for (const e of sim.players) {
      if (!e.alive || e.team === me.team) continue;
      const d = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z);
      if (this.canSee(e)) {
        // Stick with the current target unless someone is much closer.
        const score = e === cur ? d * 0.6 : d;
        if (score < bestD) { bestD = score; best = e; }
      } else if (now - e.lastShotAt < 0.25 && d < 32 && now - this.lastSeenAt > 1) {
        // Heard gunfire: turn to face it.
        this.lastSeen.x = e.pos.x; this.lastSeen.y = e.pos.y; this.lastSeen.z = e.pos.z;
        this.lastSeenAt = now;
      }
    }
    if (best) {
      if (best.id !== this.target || !this.visible) {
        const turn = Math.abs(angleDelta(this.aimYaw, yawTo(me.pos.x, me.pos.z, best.pos.x, best.pos.z)));
        this.reactAt = now + lerp(0.55, 0.17, this.skill) + sim.rng.next() * 0.12 + turn * 0.12;
        this.burstLeft = 0;
        this.pauseUntil = 0;
      }
      this.target = best.id;
      this.visible = true;
      this.lastSeen.x = best.pos.x; this.lastSeen.y = best.pos.y; this.lastSeen.z = best.pos.z;
      this.lastSeenAt = now;
      // Tell the team where the fight is.
      const intel = sim.intel[me.team];
      const site = Math.hypot(best.pos.x - sim.map.sites[0].center.x, best.pos.z - sim.map.sites[0].center.z) <
        Math.hypot(best.pos.x - sim.map.sites[1].center.x, best.pos.z - sim.map.sites[1].center.z) ? 0 : 1;
      if (Math.abs(best.pos.x) > 8 && (best.hasCharge || now - intel.time > 4)) {
        intel.site = site;
        intel.time = now;
      }
    } else {
      if (this.visible) this.lostAt = now;
      this.visible = false;
      if (now - this.lostAt > 2.5) this.target = -1;
    }
  }

  // ---- decisions -------------------------------------------------------------------

  private decide(): void {
    const sim = this.sim, me = this.me, nav = sim.nav, rng = sim.rng;
    const c = sim.charge;
    this.wantsUse = false;

    if (sim.phase === 'freeze') {
      this.setGoal(null);
      return;
    }
    if (sim.phase === 'live' && sim.liveTime < this.startDelay) return;

    // Chase a recently seen enemy for a moment rather than forgetting about them.
    const hunting = !this.visible && this.target >= 0 && sim.time - this.lastSeenAt < 2.5;

    if (me.team === ATK) {
      if (c.state === 'dropped') {
        // Closest living attacker fetches the charge.
        let closest = me, cd = this.distTo(c.pos);
        for (const p of sim.players) {
          if (!p.alive || p.team !== ATK || !p.isBot) continue;
          const d = Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z);
          if (d < cd) { cd = d; closest = p; }
        }
        if (closest === me) { this.setGoal(c.pos); return; }
      }
      if (c.state === 'planted') {
        if (!this.spot || Math.hypot(this.spot.x - c.pos.x, this.spot.z - c.pos.z) > 11) {
          this.spot = nav.randomNear(c.pos.x, c.pos.z, 9, rng, c.pos.y) ?? c.pos;
        }
        this.setGoal(this.spot);
        return;
      }
      if (this.route.length > 0) {
        const wp = this.route[0]!;
        if (this.distTo(wp) < 2.2) this.route.shift();
        else { this.setGoal(wp); return; }
      }
      const site = sim.map.sites[this.site]!;
      if (me.hasCharge) {
        if (!this.spot) {
          const z = site.zone;
          for (let i = 0; i < 12 && !this.spot; i++) {
            const x = rng.range(z.minX + 1, z.maxX - 1), zz = rng.range(z.minZ + 1, z.maxZ - 1);
            const cell = nav.index(x, zz);
            if (nav.walkable(cell) && !nav.edge[cell]) this.spot = { x, y: nav.height[cell]!, z: zz };
          }
          if (!this.spot) this.spot = site.center;
        }
        this.setGoal(this.spot);
        if (sim.canPlant(me) && (this.distTo(this.spot) < 1.2 || this.path.length === 0) && !this.visible) this.wantsUse = true;
        return;
      }
      if (hunting) { this.setGoal(this.lastSeen); return; }
      if (!this.spot) this.spot = nav.randomNear(site.center.x, site.center.z, 7, rng, 0) ?? site.center;
      this.setGoal(this.spot);
      return;
    }

    // ---- defenders ----
    if (c.state === 'planted') {
      // The closest defender disarms; the rest cover.
      let closest = me, cd = this.distTo(c.pos);
      for (const p of sim.players) {
        if (!p.alive || p.team !== DEF || !p.isBot) continue;
        const d = Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z);
        if (d < cd) { cd = d; closest = p; }
      }
      if (closest === me) {
        this.setGoal(c.pos);
        const urgent = c.timer < sim.disarmDuration(me) + 3;
        if (sim.canDisarm(me) && (!this.visible || urgent || me.useTime > sim.disarmDuration(me) * 0.6)) this.wantsUse = true;
      } else {
        if (!this.spot || Math.hypot(this.spot.x - c.pos.x, this.spot.z - c.pos.z) > 9) {
          this.spot = nav.randomNear(c.pos.x, c.pos.z, 7, rng, c.pos.y) ?? c.pos;
        }
        this.setGoal(this.spot);
      }
      return;
    }
    if (hunting && this.distTo(this.lastSeen) < 14) { this.setGoal(this.lastSeen); return; }
    // Rotate toward the site the team has called.
    const intel = sim.intel[DEF];
    if (intel.site >= 0 && intel.site !== this.site && sim.time - intel.time < 8 && sim.time - intel.time > 1 + (me.id % 3)) {
      this.site = intel.site;
      const site = sim.map.sites[this.site]!;
      const h = rng.pick(site.holds);
      this.holdPos = nav.randomNear(h.pos.x, h.pos.z, 2.5, rng, h.pos.y) ?? h.pos;
      this.holdLook = h.look;
    }
    this.setGoal(this.holdPos);
  }

  private buy(): void {
    const sim = this.sim, me = this.me;
    this.bought = true;
    const rifle = me.team === ATK ? 'hammerhead' : 'lumen';
    const riflePrice = me.team === ATK ? 2700 : 3000;
    if (!me.weapons[0]) {
      if (me.money >= riflePrice + 1000) { sim.tryBuy(me, rifle); sim.tryBuy(me, 'armorhelmet'); }
      else if (me.money >= riflePrice + 650) { sim.tryBuy(me, rifle); sim.tryBuy(me, 'armor'); }
      else if (me.money >= 1900 && sim.rng.next() < 0.75) { sim.tryBuy(me, 'wasp'); sim.tryBuy(me, 'armor'); }
      else if (me.money >= 1750 && sim.rng.next() < 0.3) { sim.tryBuy(me, 'breaker'); sim.tryBuy(me, 'armor'); }
      else if (me.money < 1000 && me.money >= 650 && sim.round === 1) sim.tryBuy(me, 'armor');
    } else if (me.armor < 60 || !me.helmet) {
      sim.tryBuy(me, 'armorhelmet') || sim.tryBuy(me, 'armor');
    }
    if (me.team === DEF && me.money >= 1400) sim.tryBuy(me, 'kit');
    if (me.weapons[0] && me.active !== 0) me.active = 0;
  }

  // ---- per tick --------------------------------------------------------------------

  think(cmd: Cmd): void {
    const sim = this.sim, me = this.me, now = sim.time, rng = sim.rng;
    cmd.fwd = 0; cmd.side = 0; cmd.buttons = 0; cmd.slot = -1; cmd.buy = '';
    cmd.yaw = this.aimYaw; cmd.pitch = this.aimPitch;
    if (!me.alive) return;

    if (!this.bought && sim.phase === 'freeze' && now >= this.buyAt) this.buy();
    if (now >= this.nextSense) { this.nextSense = now + 0.09; this.sense(); }
    if (now >= this.nextDecide) { this.nextDecide = now + 0.25; this.decide(); }

    const tgt = this.visible && this.target >= 0 ? sim.players[this.target]! : null;
    const w = me.weapons[me.active]!;
    const def = w.def;

    // Prefer the primary; fall back to the sidearm when it is dry mid-fight.
    if (me.weapons[0] && me.active !== 0 && (me.weapons[0].mag > 0 || !tgt)) cmd.slot = 0;
    else if (me.active === 0 && w.mag === 0 && tgt && me.weapons[1] && me.weapons[1].mag > 0) cmd.slot = 1;
    else if (me.active === 2 && me.weapons[1]) cmd.slot = 1;

    // ---- aim ----
    let wantYaw = this.aimYaw, wantPitch = 0;
    let dist = 0;
    const ey = me.pos.y + eyeHeight(me);
    if (tgt) {
      if (now > this.errUntil) {
        const mag = lerp(0.05, 0.011, this.skill);
        this.errYaw = (rng.next() - 0.5) * 2 * mag;
        this.errPitch = (rng.next() - 0.5) * 2 * mag * 0.7;
        this.errUntil = now + 0.25 + rng.next() * 0.25;
      }
      const dx = tgt.pos.x - me.pos.x, dz = tgt.pos.z - me.pos.z;
      dist = Math.hypot(dx, dz);
      // Aim between chest and head; better bots favour the head.
      const aimH = lerp(1.2, eyeHeight(tgt) + 0.02, 0.35 + this.skill * 0.55) * (1 - 0.1 * tgt.crouchT);
      const dy = tgt.pos.y + aimH - ey;
      const comp = lerp(0.35, 0.9, this.skill);
      wantYaw = yawTo(me.pos.x, me.pos.z, tgt.pos.x, tgt.pos.z) + this.errYaw - me.punchYaw * comp;
      wantPitch = Math.atan2(dy, dist) + this.errPitch - me.punchPitch * comp;
    } else if (now - this.lastSeenAt < 3 && this.distTo(this.lastSeen) > 1) {
      wantYaw = yawTo(me.pos.x, me.pos.z, this.lastSeen.x, this.lastSeen.z);
      wantPitch = Math.atan2(this.lastSeen.y + 1.2 - ey, Math.max(1, this.distTo(this.lastSeen)));
    } else if (this.pathI < this.path.length) {
      const look = this.path[Math.min(this.path.length - 1, this.pathI + 1)]!;
      if (this.distTo(look) > 0.8) wantYaw = yawTo(me.pos.x, me.pos.z, look.x, look.z);
    } else if (this.holdLook && me.team === DEF && sim.phase === 'live') {
      wantYaw = yawTo(me.pos.x, me.pos.z, this.holdLook.x, this.holdLook.z);
    } else if (sim.phase !== 'freeze') {
      // Idle: sweep the entrances of the site being held.
      const ents = sim.map.sites[this.site]!.entrances;
      const e = ents[(Math.floor(now / 2.2) + me.id) % ents.length]!;
      wantYaw = yawTo(me.pos.x, me.pos.z, e.x, e.z);
    }
    const maxTurn = lerp(5, 11, this.skill) * (1 / 64);
    const dYaw = angleDelta(this.aimYaw, wantYaw);
    const dPitch = wantPitch - this.aimPitch;
    const gain = tgt ? 0.22 : 0.12;
    this.aimYaw = wrapAngle(this.aimYaw + clamp(dYaw * gain, -maxTurn, maxTurn));
    this.aimPitch = clamp(this.aimPitch + clamp(dPitch * gain, -maxTurn, maxTurn), -1.4, 1.4);
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;

    // ---- shoot ----
    let engaging = false;
    if (tgt && now >= this.reactAt && def.kind !== 'knife') {
      const idealYaw = yawTo(me.pos.x, me.pos.z, tgt.pos.x, tgt.pos.z);
      const yawErr = Math.abs(angleDelta(this.aimYaw + me.punchYaw, idealYaw));
      const tol = Math.max(0.02, 0.42 / Math.max(1, dist));
      engaging = true;
      if (yawErr < tol && w.mag > 0 && me.reloadTimer <= 0) {
        if (def.auto) {
          if (now >= this.pauseUntil) {
            if (this.burstLeft <= 0) {
              this.burstLeft = dist > 22 ? 1 + rng.int(2) : dist > 10 ? 3 + rng.int(3) : 8 + rng.int(8);
            }
            cmd.buttons |= BTN_FIRE;
            if (now - me.lastShotAt < 1 / 64 + 1e-4) {
              // A round just left the barrel.
              if (--this.burstLeft <= 0) this.pauseUntil = now + (dist > 22 ? 0.32 : 0.2) + rng.next() * 0.15;
            }
          }
        } else {
          // Semi-auto: click, release, click.
          if (!this.fireHeld && now >= this.pauseUntil) {
            cmd.buttons |= BTN_FIRE;
            this.fireHeld = true;
            this.pauseUntil = now + 60 / def.rpm + lerp(0.14, 0.03, this.skill) + rng.next() * 0.08;
          } else {
            this.fireHeld = false;
          }
        }
      }
    }
    if (def.kind === 'knife' && tgt && dist < 1.7) cmd.buttons |= BTN_FIRE;
    if (def.magSize > 0 && me.reloadTimer <= 0 && w.reserve > 0 && (w.mag === 0 || (!tgt && now - this.lastSeenAt > 3 && w.mag < def.magSize * 0.4))) {
      cmd.buttons |= BTN_RELOAD;
    }

    // ---- move ----
    if (this.wantsUse) {
      cmd.buttons |= BTN_USE;
      return;
    }
    let mx = 0, mz = 0;
    const holdGround = engaging && dist > 5.5;
    if (holdGround) {
      // Stand still to shoot accurately; sidestep between bursts.
      if (now >= this.strafeUntil) {
        this.strafe = now < this.pauseUntil || me.reloadTimer > 0 ? (rng.next() < 0.5 ? -1 : 1) : 0;
        this.strafeUntil = now + 0.25 + rng.next() * 0.3;
        if (rng.next() < 0.18 * this.skill && dist < 22) this.crouchUntil = now + 0.8;
      }
      if (this.strafe !== 0 && (now < this.pauseUntil || me.reloadTimer > 0)) {
        mx = Math.cos(this.aimYaw) * this.strafe;
        mz = -Math.sin(this.aimYaw) * this.strafe;
      }
      if (now < this.crouchUntil) cmd.buttons |= BTN_CROUCH;
    } else if (this.pathI < this.path.length) {
      let wp = this.path[this.pathI]!;
      if (this.distTo(wp) < 0.45) {
        this.pathI++;
        if (this.pathI < this.path.length) wp = this.path[this.pathI]!;
      }
      if (this.pathI < this.path.length) {
        const dx = wp.x - me.pos.x, dz = wp.z - me.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        mx = dx / d;
        mz = dz / d;
        if (engaging) {
          // Close-range fight: keep moving, add some strafe.
          if (now >= this.strafeUntil) { this.strafe = rng.next() < 0.5 ? -1 : 1; this.strafeUntil = now + 0.4; }
          mx += Math.cos(this.aimYaw) * this.strafe * 0.8;
          mz += -Math.sin(this.aimYaw) * this.strafe * 0.8;
        }
      }
    } else if (this.goal && this.distTo(this.goal) > 1.5 && now >= this.nextDecide - 0.2) {
      // Path ran out short of the goal (pushed off it, or the path failed): replan.
      const g = this.goal;
      this.goal = null;
      this.setGoal(g);
    }

    if (mx !== 0 || mz !== 0) {
      forwardFromAngles(this.aimYaw, 0, f3);
      cmd.fwd = clamp(mx * f3.x + mz * f3.z, -1, 1);
      cmd.side = clamp(mx * Math.cos(this.aimYaw) + mz * -Math.sin(this.aimYaw), -1, 1);

      // Stuck detection: if we want to move but are not, hop and replan.
      if (now >= this.stuckCheckAt) {
        if (this.stuckCheckAt > 0 && !holdGround && Math.hypot(me.pos.x - this.stuckX, me.pos.z - this.stuckZ) < 0.25) {
          this.jumpAt = now;
          const g = this.goal;
          this.goal = null;
          this.setGoal(g);
        }
        this.stuckX = me.pos.x;
        this.stuckZ = me.pos.z;
        this.stuckCheckAt = now + 0.8;
      }
      if (this.jumpAt >= 0 && now - this.jumpAt < 0.05) cmd.buttons |= BTN_JUMP;
    } else {
      this.stuckCheckAt = 0;
    }
  }
}

/** Hand out a plan to every bot at the start of a round. */
export function assignRoles(sim: Sim): void {
  const rng = sim.rng;
  const map = sim.map;
  const attackSite = rng.int(2);
  const siteRoutes = map.routes.filter((r) => r.site === attackSite);
  const defenders: Bot[] = [];
  for (const bot of sim.bots.values()) {
    bot.reset();
    bot.holdPos = null;
    bot.holdLook = null;
    if (bot.me.team === ATK) {
      // Most of the team commits together; the odd one takes another lane.
      const lurk = rng.next() < 0.15;
      const route = lurk ? rng.pick(map.routes) : rng.pick(siteRoutes);
      bot.site = attackSite;
      bot.route = route.points.slice();
      bot.startDelay = rng.next() * 1.2;
    } else {
      bot.route = [];
      bot.startDelay = 0;
      defenders.push(bot);
    }
  }
  // Defenders: split across both sites with one watching mid.
  for (let i = defenders.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = defenders[i]!; defenders[i] = defenders[j]!; defenders[j] = t;
  }
  const slots = [0, 1, 0, 1, 2];
  const used = [0, 0, 0];
  defenders.forEach((bot, i) => {
    const slot = slots[i % slots.length]!;
    if (slot === 2) {
      const h = map.midHolds[used[2]!++ % map.midHolds.length]!;
      bot.site = rng.int(2);
      bot.holdPos = h.pos;
      bot.holdLook = h.look;
    } else {
      const site = map.sites[slot]!;
      const h = site.holds[used[slot]!++ % site.holds.length]!;
      bot.site = slot;
      bot.holdPos = h.pos;
      bot.holdLook = h.look;
    }
  });
}
