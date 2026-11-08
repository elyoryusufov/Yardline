/** Desk model of the ESP32 kindergarten tracker: Kalman fusion + failsafes. */

export const SLOT_COUNT = 40;
export const WHEEL_CIRC_M = 2;
export const MIN_SATS = 4;
export const MAX_HDOP = 8;
export const MOVING_KMH = 3;
export const DEFAULT_LIMIT = 20;

export type Flags = {
  gpsOk: boolean;
  wheelOk: boolean;
  over: boolean;
  event: boolean;
  gpsWarn: boolean;
  wheelWarn: boolean;
  noData: boolean;
};

export type LogRec = {
  seq: number;
  speed: number;
  gps: number;
  wheel: number;
  limit: number;
  flags: Flags;
  tSec: number;
};

export type Sample = {
  t: number;
  gps: number;
  wheel: number;
  fused: number;
  limit: number;
};

export class Kalman1D {
  x = 0;
  p = 1000;
  constructor(public q: number, public r: number) {}
  predict(dtMs: number) {
    this.p += this.q * (dtMs / 1000);
  }
  update(z: number, measR: number) {
    const k = this.p / (this.p + measR);
    this.x += k * (z - this.x);
    this.p *= 1 - k;
  }
  reset(v: number) {
    this.x = v;
    this.p = 1000;
  }
  value() {
    return this.x;
  }
}

export function gpsNoiseR(hdop: number) {
  return 4 + hdop * hdop;
}

export type World = {
  elapsed: number;
  lat: number;
  lon: number;
  trueKmh: number;
  gpsKmh: number;
  wheelKmh: number;
  fusedKmh: number;
  sats: number;
  hdop: number;
  gpsOk: boolean;
  wheelOk: boolean;
  wheelFresh: boolean;
  over: boolean;
  noData: boolean;
  inZone: boolean;
  distanceM: number;
};

export type Faults = {
  canopy: boolean;
  wheelCut: boolean;
  radarGlare: boolean;
};

function wrap(n: number, m: number) {
  return ((n % m) + m) % m;
}

/** Kindergarten street: 180 m approach, 80 m zone, 120 m exit. Loop. */
export function zoneOf(distanceM: number) {
  const loop = 380;
  const d = wrap(distanceM, loop);
  const inZone = d >= 180 && d < 260;
  return { d, inZone, loop };
}

export function stepWorld(prev: World | null, dt: number, faults: Faults, limit: number): {
  world: World;
  pulses: number;
} {
  const elapsed = (prev?.elapsed ?? 0) + dt;
  const base = 28 * (1 + Math.sin((elapsed * 2 * Math.PI) / 36));
  let trueKmh = Math.max(0, base + (Math.sin(elapsed * 1.7) * 1.2));
  if (faults.radarGlare) trueKmh = Math.min(trueKmh, 12);

  const distanceM = (prev?.distanceM ?? 40) + (trueKmh / 3.6) * dt;
  const { d, inZone } = zoneOf(distanceM);

  const blackout = faults.canopy && inZone;
  const sats = blackout ? 3 : 8 + Math.round(Math.sin(elapsed) > 0 ? 2 : 0);
  const hdop = blackout ? 7.8 : 1.1 + (Math.sin(elapsed * 0.4) + 1) * 0.25;

  const gpsRaw = Math.max(0, trueKmh + Math.sin(elapsed * 3.1) * 2.4);
  const gpsKmh = blackout ? 0 : gpsRaw;
  const gpsOk =
    !blackout && sats >= MIN_SATS && hdop < MAX_HDOP;

  const wheelCut = faults.wheelCut;
  const wheelNoise = wheelCut ? 0 : Math.max(0, trueKmh + Math.sin(elapsed * 8) * 0.35);
  const dtMs = dt * 1000;
  const meters = (wheelNoise / 3.6) * dt;
  const pulses = wheelCut ? 0 : meters / WHEEL_CIRC_M;
  const wheelKmh = wheelCut ? 0 : (pulses * WHEEL_CIRC_M / dt) * 3.6;
  const wheelFresh = !wheelCut && (trueKmh > 0.4 || pulses > 0);

  return {
    pulses,
    world: {
      elapsed,
      lat: 59.437 + Math.sin(elapsed / 120) * 0.002,
      lon: 24.7536 + d * 0.00001,
      trueKmh,
      gpsKmh: gpsOk ? gpsKmh : prev?.fusedKmh ?? 0,
      wheelKmh,
      fusedKmh: prev?.fusedKmh ?? 0,
      sats,
      hdop,
      gpsOk,
      wheelOk: false,
      wheelFresh,
      over: false,
      noData: false,
      inZone,
      distanceM,
    },
  };
}

export function fuse(
  kf: Kalman1D,
  w: World,
  dtMs: number,
  limit: number,
  rising: boolean,
): { world: World; event: boolean } {
  const wheelOk = w.wheelFresh || (w.gpsOk && w.gpsKmh < MOVING_KMH);
  kf.predict(dtMs);
  if (w.gpsOk) kf.update(w.gpsKmh, gpsNoiseR(w.hdop));
  if (wheelOk && w.wheelFresh) kf.update(w.wheelKmh, 1);
  const fused = Math.max(0, kf.value());
  const noData = !w.gpsOk && !wheelOk;
  const shown = noData ? 0 : fused;
  const over = shown > limit;
  return {
    event: over && !rising,
    world: { ...w, fusedKmh: fused, wheelOk, over, noData, gpsKmh: w.gpsOk ? w.gpsKmh : fused },
  };
}

export function scanResume(slots: Array<LogRec | null>): number {
  let best = 0;
  slots.forEach((r, i) => {
    if (r && r.seq > best && r.seq % SLOT_COUNT === i) best = r.seq;
  });
  return best + 1;
}
