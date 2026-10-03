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

/**
 * Tall storage is a wardrobe: against a wall, shot from the front only, and
 * often far wider than RoomPlan's box (device test 2026-10-03: a ~5 m
 * wardrobe came as one 1.18 m box). The room pass covers it; a walk-around
 * cannot.
 */
export const WARDROBE_MIN_H = 1.5;

export function wantsOwnScan(o: RoomPlanObject): boolean {
  if (o.category === 'storage' && o.size[1] >= WARDROBE_MIN_H) return false;
  return OWN_SCAN.has(o.category) && o.size[0] * o.size[2] > MIN_BASE_M2;
}

/**
 * Same piece under a new RoomPlan identifier? RoomPlan re-identifies pieces
 * while it refines them: device test 2026-10-03 had one desk under 5 ids
 * (centres within 11 cm), each one asked for again after the last was done.
 * Same category and the footprint centres within half the smaller piece's
 * short side (at least 30 cm).
 */
export function samePiece(a: RoomPlanObject, b: RoomPlanObject): boolean {
  if (a.category !== b.category) return false;
  const d = Math.hypot(a.center[0] - b.center[0], a.center[2] - b.center[2]);
  const short = Math.min(a.size[0], a.size[2], b.size[0], b.size[2]);
  return d <= Math.max(0.3, short / 2);
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
  /** Where to hold the phone to shoot it (on free floor, at a height a person can hold). */
  cam: Vec3;
  ring: number;
  azimuth: number;
  filled: boolean;
  /**
   * A person can get there: free floor along this direction and a phone
   * height between PHONE_MIN_M and PHONE_MAX_M above the floor. Only these
   * count toward progress (test 2026-10-03: a third of the bed's dome was
   * behind the headboard wall or across other furniture, so 100% could
   * never come).
   */
  reachable: boolean;
};

/** Phone heights above the floor a person can shoot from (crouched to arm up). */
export const PHONE_MIN_M = 0.4;
export const PHONE_MAX_M = 1.9;
/** Nearest a person stands to the piece's side. */
const STAND_GAP_M = 0.3;

/** Optional knowledge of the room for placing camera spots. */
export type Room = { free?: (p: Vec3) => boolean; floorY?: number | null };

/**
 * Where to hold the phone for direction (h, el): along the horizontal line
 * from the centre, between the piece's side and the farthest distance that
 * still fills the slice, the closest to the ideal close-up distance that is
 * on free floor at a holdable height. null = nowhere.
 */
export function standSpot(o: RoomPlanObject, h: Vec3, el: number, room: Room): Vec3 | null {
  const ideal = closeDistance(o) * Math.cos(el);
  const lo = reach(o, h) + STAND_GAP_M;
  const hi = closeDistance(o) * MAX_DIST_MUL * Math.cos(el);
  const cands: number[] = ideal >= lo && ideal <= hi ? [ideal] : [];
  for (let d = lo; d <= hi + 1e-9; d += 0.1) cands.push(d);
  cands.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
  for (const d of cands) {
    const p: Vec3 = [o.center[0] + h[0] * d, o.center[1] + d * Math.tan(el), o.center[2] + h[2] * d];
    if (room.floorY != null && (p[1] < room.floorY + PHONE_MIN_M || p[1] > room.floorY + PHONE_MAX_M)) continue;
    if (room.free && !room.free(p)) continue;
    return p;
  }
  return null;
}

/** Re-place unfilled slices as the floor map grows. */
export function refreshDome(dome: Slice[], o: RoomPlanObject, room: Room): void {
  for (const s of dome) {
    if (s.filled) continue;
    const h = norm([s.dir[0], 0, s.dir[2]]);
    const spot = standSpot(o, h, Math.asin(s.dir[1]), room);
    s.reachable = spot !== null;
    if (spot) s.cam = spot;
  }
}

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

export function makeDome(o: RoomPlanObject, eyeY: number, walls: RoomPlanWall[], room: Room = {}): Slice[] {
  const r = closeDistance(o);
  const out: Slice[] = [];
  LEVEL_DISTANCES.forEach((d, ring) => {
    const el = Math.atan2(eyeY - o.center[1], d);
    for (let a = 0; a < AZIMUTHS; a++) {
      const az = (a * 360) / AZIMUTHS;
      const h: Vec3 = [Math.sin(az * RAD), 0, -Math.cos(az * RAD)];
      if (blockedByWall(o, h, walls)) continue;
      const dir: Vec3 = [h[0] * Math.cos(el), Math.sin(el), h[2] * Math.cos(el)];
      const spot = standSpot(o, h, el, room);
      out.push({
        dir, cam: spot ?? add(o.center, mul(dir, r)), ring, azimuth: az, filled: false, reachable: spot !== null,
      });
    }
  });
  return out;
}

/** Farthest a filling frame may be, in close distances. */
export const MAX_DIST_MUL = 1.35;

/**
 * Is the camera looking at the piece? Its view axis hits the box (grown
 * 5 cm), or the centre is within AIM_DEG. A centre-only rule failed on the
 * bed: close up, a phone looks at part of it, not its middle (test
 * 2026-10-03: 99 of 166 bed frames rejected).
 */
export function aimedAt(o: RoomPlanObject, camPos: Vec3, camFwd: Vec3): boolean {
  if (angleDeg(camFwd, sub(o.center, camPos)) <= AIM_DEG) return true;
  const { ax, az } = axes(o);
  const d = sub(camPos, o.center);
  const lo = [dot(d, ax), d[1], dot(d, az)];
  const ld = [dot(camFwd, ax), camFwd[1], dot(camFwd, az)];
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const half = o.size[i] / 2 + 0.05;
    if (Math.abs(ld[i]) < 1e-9) {
      if (Math.abs(lo[i]) > half) return false;
      continue;
    }
    const a = (-half - lo[i]) / ld[i];
    const b = (half - lo[i]) / ld[i];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

/**
 * The slice a kept frame from `camPos` looking along `camFwd` fills, or -1.
 * Spec §3.5: direction within SLICE_DEG, the piece in view (aimedAt) and
 * close (no further than MAX_DIST_MUL close distances).
 */
export function sliceFor(dome: Slice[], o: RoomPlanObject, camPos: Vec3, camFwd: Vec3): number {
  const toCam = sub(camPos, o.center);
  const dist = len(toCam);
  if (dist < 0.3 || dist > closeDistance(o) * MAX_DIST_MUL) return -1;
  if (!aimedAt(o, camPos, camFwd)) return -1;
  let best = -1;
  let bestA = SLICE_DEG;
  dome.forEach((s, i) => {
    const a = angleDeg(s.dir, toCam);
    if (a <= bestA) { bestA = a; best = i; }
  });
  return best;
}

/** Slices that count: reachable ones, and any the user filled anyway. */
const counted = (dome: Slice[]) => dome.filter((s) => s.reachable || s.filled);

/** Share of the counted slices filled; 0 when none can be reached (the user ends it). */
export function domeProgress(dome: Slice[]): number {
  const c = counted(dome);
  return c.length ? c.filter((s) => s.filled).length / c.length : 0;
}

/** Every reachable slice filled (and there was at least one). */
export const domeComplete = (dome: Slice[]) => counted(dome).length > 0 && domeProgress(dome) >= 1;

/** The unfilled reachable slice closest (in direction) to where the phone is now. */
export function nextSlice(dome: Slice[], o: RoomPlanObject, camPos: Vec3): number {
  const toCam = sub(camPos, o.center);
  let best = -1;
  let bestA = Infinity;
  dome.forEach((s, i) => {
    if (s.filled || !s.reachable) return;
    const a = angleDeg(s.dir, toCam);
    if (a < bestA) { bestA = a; best = i; }
  });
  return best;
}

/**
 * Hint for reaching a slice. Distance first (the height needed depends on
 * it), then the height the slice's direction asks for AT THE PHONE'S
 * CURRENT DISTANCE -- the old fixed spot asked for the phone 2.5 m above
 * the floor on the bed's top ring (test 2026-10-03).
 */
export function sliceHint(s: Slice, camPos: Vec3, o: RoomPlanObject): string | null {
  const hNow = Math.hypot(camPos[0] - o.center[0], camPos[2] - o.center[2]);
  const hSpot = Math.hypot(s.cam[0] - o.center[0], s.cam[2] - o.center[2]);
  if (hNow > hSpot + 0.5) return 'Biraz yaklaş';
  if (hNow < hSpot - 0.5) return 'Biraz uzaklaş';
  const el = Math.asin(Math.max(-1, Math.min(1, s.dir[1])));
  const dy = o.center[1] + hNow * Math.tan(el) - camPos[1];
  if (dy > 0.12) return 'Telefonu kaldır';
  if (dy < -0.12) return dy < -0.5 ? 'Eğil, telefonu alçalt' : 'Telefonu biraz indir';
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
/**
 * ...and has been pointed at it this long. Entry used to wait for the room
 * guidance to have nothing left to show; it almost always had a target, so
 * the dresser never started and the bed started out of nowhere (test
 * 2026-10-03). Looking at a close piece is the user's own signal.
 */
export const ENTER_AIM_S = 1.0;
/** Spec §3.4: black screen before object mode. */
export const ENTER_BLACK_S = 2.0;
/** Spec §3.6: back at the locked height within this, the camera comes back. */
export const RETURN_BAND_M = 0.05;
/** Spec §3.6: after this long on the black screen the hint names a direction. */
export const RETURN_HINT_AFTER_S = 10;

export type ModeState =
  /** `eyeing`: a close pending piece the phone has pointed at since `since`. */
  | { kind: 'room'; eyeing?: { id: string; since: number } }
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

/** The closest pending piece within ENTER_M that the phone points at, or null. */
export function eyedPiece(pending: RoomPlanObject[], pos: Vec3, fwd: Vec3): RoomPlanObject | null {
  let best: RoomPlanObject | null = null;
  let bestD = ENTER_M;
  for (const o of pending) {
    const d = footprintDistance(pos, o);
    if (d <= bestD && aimedAt(o, pos, fwd)) { bestD = d; best = o; }
  }
  return best;
}

/**
 * One tick. `pending` are pieces still to scan; `complete` says the current
 * piece's dome is done (or the user ended it); `heightDev` is the phone's
 * height minus the room lock.
 */
export function stepMode(
  s: ModeState,
  input: { now: number; pos: Vec3; fwd: Vec3; pending: RoomPlanObject[]; complete: boolean; heightDev: number },
): ModeState {
  switch (s.kind) {
    case 'room': {
      const o = eyedPiece(input.pending, input.pos, input.fwd);
      if (!o) return s.eyeing ? { kind: 'room' } : s;
      if (s.eyeing?.id !== o.id) return { kind: 'room', eyeing: { id: o.id, since: input.now } };
      return input.now - s.eyeing.since >= ENTER_AIM_S ? { kind: 'toObject', id: o.id, since: input.now } : s;
    }
    case 'toObject':
      return input.now - s.since >= ENTER_BLACK_S ? { kind: 'object', id: s.id } : s;
    case 'object':
      return input.complete ? { kind: 'toRoom', id: s.id, since: input.now } : s;
    case 'toRoom':
      return Math.abs(input.heightDev) <= RETURN_BAND_M ? { kind: 'room' } : s;
  }
}
