/**
 * Vista pass targets (spec 2026-09-30-pencere-manzara-design.md §4).
 *
 * When the vista pass starts, the level heading the phone points at becomes
 * the centre of a half-sphere grid: yaw -90..+90 in 30 deg steps, pitch
 * -45/-15/+15/+45. Each target is shot once (three exposures, native side)
 * after the camera has sat within ALIGN_DEG of it for HOLD_S with healthy
 * tracking. World is ARKit's: +Y up, the camera looks down its own -Z.
 */
export type Vec3 = [number, number, number];
export type ScreenDirection = { right: number; up: number; forward: number };

export const ALIGN_DEG = 6;
export const HOLD_S = 0.6;
const YAWS = [-90, -60, -30, 0, 30, 60, 90];
const PITCHES = [-45, -15, 15, 45];
const RAD = Math.PI / 180;

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function angleDeg(a: Vec3, b: Vec3): number {
  const x = norm(a);
  const y = norm(b);
  const d = Math.max(-1, Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2]));
  return Math.acos(d) / RAD;
}

export function makeTargets(startForward: Vec3): Vec3[] {
  const h = norm([startForward[0], 0, startForward[2]]);
  const base = Math.atan2(h[0], -h[2]); // 0 = world -Z, positive towards +X
  const out: Vec3[] = [];
  for (const p of PITCHES) {
    for (const y of YAWS) {
      const a = base + y * RAD;
      const cp = Math.cos(p * RAD);
      out.push([Math.sin(a) * cp, Math.sin(p * RAD), -Math.cos(a) * cp]);
    }
  }
  return out;
}

// Same mapping as GuidanceEngine.screen(): the sensor is landscape (home side
// right), so camera +Y is portrait right and camera +X is portrait down.
export function toScreen(dir: Vec3, pose16: number[]): ScreenDirection {
  // Column-major camera-to-world: columns 0..2 are the camera axes in world.
  const cx: Vec3 = [pose16[0], pose16[1], pose16[2]];
  const cy: Vec3 = [pose16[4], pose16[5], pose16[6]];
  const cz: Vec3 = [pose16[8], pose16[9], pose16[10]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c: Vec3 = [dot(cx, dir), dot(cy, dir), dot(cz, dir)]; // world -> camera (R^T d)
  return { right: c[1], up: -c[0], forward: -c[2] };
}

export function nextTarget(targets: Vec3[], done: boolean[], forward: Vec3): number {
  let best = -1;
  let bestA = Infinity;
  targets.forEach((t, i) => {
    if (done[i]) return;
    const a = angleDeg(t, forward);
    if (a < bestA) { bestA = a; best = i; }
  });
  return best;
}

export function holdStep(state: { held: number }, aligned: boolean, trackingNormal: boolean, dt: number): boolean {
  if (!aligned || !trackingNormal) {
    state.held = 0;
    return false;
  }
  state.held += dt;
  if (state.held >= HOLD_S) {
    state.held = 0;
    return true;
  }
  return false;
}
