/**
 * Object mode (spec docs/superpowers/specs/2026-10-02-uygulama-mimarisi.md §3.3-3.6).
 *
 * RoomPlan finds the main furniture; each piece is walked around separately,
 * at any height, until a half dome of directions around it is filled. Those
 * frames train the piece on their own (worker/object_lock.py), so the tour
 * shows it sharp from wherever a visitor looks.
 *
 * Pure math, ARKit world (+Y up, metres). The screen hook is useObjectMode.ts.
 */
import type { RoomPlanObject, RoomPlanWall } from '../../modules/arkit-capture/src/ArkitCapture.types';

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));
export const angleDeg = (a: Vec3, b: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) / RAD;

// ---------------------------------------------------------------- selection

/** RoomPlan categories that get their own walk-around (built-ins and flat ones do not). */
const OWN_SCAN = new Set(['storage', 'bed', 'table', 'sofa', 'chair', 'refrigerator', 'fireplace', 'washerDryer']);
/** Spec §3.3: footprint over 0.3 m². */
export const MIN_BASE_M2 = 0.3;
/** Spec §3.8: grown ~3 cm on every side so the edge of the piece stays inside. */
export const BOX_PAD_M = 0.03;

export function wantsOwnScan(o: RoomPlanObject): boolean {
  return OWN_SCAN.has(o.category) && o.size[0] * o.size[2] > MIN_BASE_M2;
}

/** Turkish name. RoomPlan says only "storage"; size tells dresser, nightstand and wardrobe apart. */
export function displayName(o: RoomPlanObject): string {
  const h = o.size[1];
  switch (o.category) {
    case 'storage':
      if (h >= 1.5) return 'Dolap';
      if (h < 0.75 && o.size[0] < 0.7) return 'Komidin';
      return 'Şifonyer';
    case 'bed': return 'Yatak';
    case 'table': return 'Masa';
    case 'sofa': return 'Kanepe';
    case 'chair': return 'Sandalye';
    case 'refrigerator': return 'Buzdolabı';
    case 'fireplace': return 'Şömine';
    case 'washerDryer': return 'Çamaşır makinesi';
    default: return 'Eşya';
  }
}

/** The box as objects.json wants it (grown by BOX_PAD_M). */
export function exportBox(o: RoomPlanObject) {
  return {
    id: o.id,
    name: displayName(o),
    category: o.category,
    center: o.center,
    size: o.size.map((s) => s + 2 * BOX_PAD_M) as Vec3,
    yaw_deg: o.yaw_deg,
  };
}

/** Box x and z axes in world (same yaw convention as worker/object_lock.py). */
function axes(o: { yaw_deg: number }): { ax: Vec3; az: Vec3 } {
  const c = Math.cos(o.yaw_deg * RAD);
  const s = Math.sin(o.yaw_deg * RAD);
  return { ax: [c, 0, -s], az: [s, 0, c] };
}

export function boxCorners(o: RoomPlanObject): Vec3[] {
  const { ax, az } = axes(o);
  const [w, h, d] = o.size;
  const out: Vec3[] = [];
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(add(add(add(o.center, mul(ax, (sx * w) / 2)), [0, (sy * h) / 2, 0]), mul(az, (sz * d) / 2)));
  }
  return out;
}

/** 12 edges as corner index pairs of boxCorners(). */
export const BOX_EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Horizontal distance from p to the box footprint (0 inside). */
export function footprintDistance(p: Vec3, o: RoomPlanObject): number {
  const { ax, az } = axes(o);
  const d = sub(p, o.center);
  const lx = Math.max(0, Math.abs(dot(d, ax)) - o.size[0] / 2);
  const lz = Math.max(0, Math.abs(dot(d, az)) - o.size[2] / 2);
  return Math.hypot(lx, lz);
}

/** How far the box reaches from its centre along horizontal unit direction h. */
function reach(o: RoomPlanObject, h: Vec3): number {
  const { ax, az } = axes(o);
  const tx = Math.abs(dot(h, ax)) > 1e-6 ? o.size[0] / 2 / Math.abs(dot(h, ax)) : Infinity;
  const tz = Math.abs(dot(h, az)) > 1e-6 ? o.size[2] / 2 / Math.abs(dot(h, az)) : Infinity;
  return Math.min(tx, tz);
}

// --------------------------------------------------------------------- dome

/**
 * Spec §3.5: 3 rings x 12 directions. Directions come from the viewer: a
 * visitor at eye height looking at the piece from LEVEL_DISTANCES away sees
 * it from those elevation angles; each is shot close up along the same line,
 * so the tour gets the same angle with near detail.
 */
export const AZIMUTHS = 12;
export const LEVEL_DISTANCES = [3.5, 2.0, 1.2];
/** A camera within this of a slice's direction fills it (spec §3.5: ≤ 8°). */
export const SLICE_DEG = 8;
/** The camera must look at the piece: centre within this of the view axis. */
export const AIM_DEG = 20;
/** Clearance a person needs between the piece and a wall to shoot that side. */
export const WALL_CLEARANCE_M = 0.45;

export type Slice = {
  /** Unit direction from the piece's centre toward the camera. */
  dir: Vec3;
  /** Where to stand (phone position) to shoot it. */
  cam: Vec3;
  ring: number;
  azimuth: number;
  filled: boolean;
};

/** Distance at which the piece fills most of a portrait frame. */
export function closeDistance(o: RoomPlanObject): number {
  const big = Math.max(o.size[0], o.size[1], o.size[2]);
  return Math.min(3.0, Math.max(0.7, 1.4 * big));
}

/** Does a wall stand closer than the clearance on the side facing h? */
export function blockedByWall(o: RoomPlanObject, h: Vec3, walls: RoomPlanWall[]): boolean {
  const limit = reach(o, h) + WALL_CLEARANCE_M;
  for (const w of walls) {
    const { ax } = axes(w); // along the wall
    const n: Vec3 = [-ax[2], 0, ax[0]]; // wall normal (either side)
    const denom = dot(h, n);
    if (Math.abs(denom) < 1e-6) continue;
    const t = dot(sub(w.center, o.center), n) / denom;
    if (t <= 0 || t > limit) continue;
    const hit = add(o.center, mul(h, t));
    if (Math.abs(dot(sub(hit, w.center), ax)) <= w.width / 2) return true;
  }
  return false;
}

export function makeDome(o: RoomPlanObject, eyeY: number, walls: RoomPlanWall[]): Slice[] {
  const r = closeDistance(o);
  const out: Slice[] = [];
  LEVEL_DISTANCES.forEach((d, ring) => {
    const el = Math.atan2(eyeY - o.center[1], d);
    for (let a = 0; a < AZIMUTHS; a++) {
      const az = (a * 360) / AZIMUTHS;
      const h: Vec3 = [Math.sin(az * RAD), 0, -Math.cos(az * RAD)];
      if (blockedByWall(o, h, walls)) continue;
      const dir: Vec3 = [h[0] * Math.cos(el), Math.sin(el), h[2] * Math.cos(el)];
      out.push({ dir, cam: add(o.center, mul(dir, r)), ring, azimuth: az, filled: false });
    }
  });
  return out;
}

/**
 * The slice a kept frame from `camPos` looking along `camFwd` fills, or -1.
 * Spec §3.5: direction within SLICE_DEG, the piece in view (centre within
 * AIM_DEG) and close (no further than 1.35x the close distance).
 */
export function sliceFor(dome: Slice[], o: RoomPlanObject, camPos: Vec3, camFwd: Vec3): number {
  const toCam = sub(camPos, o.center);
  const dist = len(toCam);
  if (dist < 0.3 || dist > closeDistance(o) * 1.35) return -1;
  if (angleDeg(camFwd, sub(o.center, camPos)) > AIM_DEG) return -1;
  let best = -1;
  let bestA = SLICE_DEG;
  dome.forEach((s, i) => {
    const a = angleDeg(s.dir, toCam);
    if (a <= bestA) { bestA = a; best = i; }
  });
  return best;
}

export const domeProgress = (dome: Slice[]) =>
  dome.length ? dome.filter((s) => s.filled).length / dome.length : 1;

/** The unfilled slice closest (in direction) to where the phone is now. */
export function nextSlice(dome: Slice[], o: RoomPlanObject, camPos: Vec3): number {
  const toCam = sub(camPos, o.center);
  let best = -1;
  let bestA = Infinity;
  dome.forEach((s, i) => {
    if (s.filled) return;
    const a = angleDeg(s.dir, toCam);
    if (a < bestA) { bestA = a; best = i; }
  });
  return best;
}

/** Spoken hint for reaching a slice's camera spot. */
export function sliceHint(s: Slice, camPos: Vec3, o: RoomPlanObject): string | null {
  const dy = s.cam[1] - camPos[1];
  if (dy > 0.15) return 'Telefonu kaldır';
  if (dy < -0.15) return camPos[1] - s.cam[1] > 0.5 ? 'Eğil, telefonu alçalt' : 'Telefonu biraz indir';
  const want = closeDistance(o);
  const have = len(sub(camPos, o.center));
  if (have > want * 1.3) return 'Biraz yaklaş';
  if (have < want * 0.6) return 'Biraz uzaklaş';
  return null;
}

/** Where to stand to begin on a piece: in front of it, toward the phone. */
export function approachPoint(o: RoomPlanObject, camPos: Vec3): Vec3 {
  const flat: Vec3 = [camPos[0] - o.center[0], 0, camPos[2] - o.center[2]];
  const h = len(flat) > 1e-6 ? norm(flat) : [0, 0, 1] as Vec3;
  return add(o.center, mul(h, reach(o, h) + 0.9));
}

// ------------------------------------------------------------- mode machine

/** Spec §3.4: the black screen comes when the phone is this close to the piece. */
export const ENTER_M = 1.5;
/** Spec §3.4: black screen before object mode. */
export const ENTER_BLACK_S = 2.0;
/** Spec §3.6: back at the locked height within this, the camera comes back. */
export const RETURN_BAND_M = 0.05;
/** Spec §3.6: after this long on the black screen the hint names a direction. */
export const RETURN_HINT_AFTER_S = 10;

export type ModeState =
  | { kind: 'room' }
  | { kind: 'toObject'; id: string; since: number }
  | { kind: 'object'; id: string }
  | { kind: 'toRoom'; id: string; since: number };

export type NativeMode = 'room' | 'object' | 'paused';

export function nativeMode(s: ModeState): { mode: NativeMode; objectId: string | null } {
  switch (s.kind) {
    case 'room': return { mode: 'room', objectId: null };
    case 'object': return { mode: 'object', objectId: s.id };
    default: return { mode: 'paused', objectId: null };
  }
}

/**
 * One tick. `pending` are pieces still to scan; `complete` says the current
 * piece's dome is done (or the user ended it); `heightDev` is the phone's
 * height minus the room lock.
 */
export function stepMode(
  s: ModeState,
  input: { now: number; pos: Vec3; pending: RoomPlanObject[]; complete: boolean; heightDev: number; enterAllowed: boolean },
): ModeState {
  switch (s.kind) {
    case 'room': {
      if (!input.enterAllowed) return s;
      let best: RoomPlanObject | null = null;
      let bestD = ENTER_M;
      for (const o of input.pending) {
        const d = footprintDistance(input.pos, o);
        if (d <= bestD) { bestD = d; best = o; }
      }
      return best ? { kind: 'toObject', id: best.id, since: input.now } : s;
    }
    case 'toObject':
      return input.now - s.since >= ENTER_BLACK_S ? { kind: 'object', id: s.id } : s;
    case 'object':
      return input.complete ? { kind: 'toRoom', id: s.id, since: input.now } : s;
    case 'toRoom':
      return Math.abs(input.heightDev) <= RETURN_BAND_M ? { kind: 'room' } : s;
  }
}
