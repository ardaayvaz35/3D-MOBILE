/**
 * Live openings (spec 2026-09-30-pencere-manzara-design.md §4).
 *
 * The native side hands over classified mesh points (window / door / floor)
 * about once a second; this file turns them into vertical rectangles
 * ("openings"), keeps their ids stable between updates, votes whether each
 * one looks out (its glass clips white while the room sets the auto
 * exposure), notices when the phone walks through one, and says which
 * directions a vista must cover to fill it. Pure math, ARKit world
 * (+Y up, metres).
 */
import type { Vec3 } from './vistaTargets';

export type OpeningKind = 'window' | 'door' | 'manual';

export type Opening = {
  id: string;
  kind: OpeningKind;
  /** Top-left, top-right, bottom-right, bottom-left as seen from the room. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  centre: Vec3;
  /** Horizontal unit normal pointing away from the room. */
  normal: Vec3;
  width: number;
  height: number;
  /** Luma votes taken while the glass was small in the frame (room sets exposure). */
  seen: number;
  clipped: number;
  /** Vista id that covers it, null until one is shot. */
  vista: string | null;
};

/** Class codes the native side uses in the point list (not ARKit's raw values). */
export const CLS_WINDOW = 1;
export const CLS_DOOR = 2;
export const CLS_FLOOR = 3;

const LINK_M = 0.35; // points closer than this belong to the same opening
const MIN_POINTS = 12;
const MIN_W = 0.3;
const MIN_H = 0.4;
const MAX_DEPTH_RMS = 0.1; // glass is flat: spread across the plane in metres
const MATCH_M = 0.4;
const CLIP_LUMA = 250;
const MIN_LUMA_SAMPLES = 8;
const UP: Vec3 = [0, 1, 0];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function centroid(pts: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const n = Math.max(1, pts.length);
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** Single-link clusters on a hash grid (cell = LINK_M). */
export function clusterPoints(pts: Vec3[]): Vec3[][] {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const cell = (p: Vec3) => p.map((v) => Math.floor(v / LINK_M)) as Vec3;
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const c = cell(p);
    const k = key(c[0], c[1], c[2]);
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  });
  const label = new Array<number>(pts.length).fill(-1);
  const out: Vec3[][] = [];
  for (let s = 0; s < pts.length; s++) {
    if (label[s] >= 0) continue;
    const id = out.length;
    const members: Vec3[] = [];
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(pts[i]);
      const c = cell(pts[i]);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const near = grid.get(key(c[0] + dx, c[1] + dy, c[2] + dz));
        if (!near) continue;
        for (const j of near) {
          if (label[j] < 0 && dist(pts[i], pts[j]) <= LINK_M) { label[j] = id; stack.push(j); }
        }
      }
    }
    out.push(members);
  }
  return out;
}

/**
 * Vertical rectangle through points: the along-wall axis is the main
 * horizontal spread, the normal is horizontal and faces away from the room.
 * Null when the points do not look like a flat opening.
 */
export function rectFromPoints(pts: Vec3[], roomCentre: Vec3, minPoints = MIN_POINTS):
  Omit<Opening, 'id' | 'kind' | 'seen' | 'clipped' | 'vista'> | null {
  if (pts.length < minPoints) return null;
  const c = centroid(pts);
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of pts) {
    const x = p[0] - c[0], z = p[2] - c[2];
    sxx += x * x; sxz += x * z; szz += z * z;
  }
  // Main axis of the 2x2 xz covariance.
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const u: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
  let n: Vec3 = [-u[2], 0, u[0]];
  if (dot(sub(c, roomCentre), n) < 0) n = mul(n, -1);
  let uMin = Infinity, uMax = -Infinity, yMin = Infinity, yMax = -Infinity, dd = 0;
  for (const p of pts) {
    const d = sub(p, c);
    const a = dot(d, u);
    uMin = Math.min(uMin, a); uMax = Math.max(uMax, a);
    yMin = Math.min(yMin, p[1]); yMax = Math.max(yMax, p[1]);
    dd += dot(d, n) ** 2;
  }
  const width = uMax - uMin;
  const height = yMax - yMin;
  if (width < MIN_W || height < MIN_H || Math.sqrt(dd / pts.length) > MAX_DEPTH_RMS) return null;
  // Seen from the room the viewer looks along n; its right is n x up.
  const right = cross(n, UP);
  const mid = add(c, mul(u, (uMin + uMax) / 2));
  const centre: Vec3 = [mid[0], (yMin + yMax) / 2, mid[2]];
  const hw = mul(right, width / 2);
  const top: Vec3 = [0, height / 2, 0];
  return {
    corners: [
      add(sub(centre, hw), top),
      add(add(centre, hw), top),
      sub(add(centre, hw), top),
      sub(sub(centre, hw), top),
    ],
    centre,
    normal: n,
    width,
    height,
  };
}

/** Flat [x, y, z, cls, x, y, z, cls, ...] from the native side. */
export function splitPoints(flat: number[]): { window: Vec3[]; door: Vec3[]; floor: Vec3[] } {
  const out = { window: [] as Vec3[], door: [] as Vec3[], floor: [] as Vec3[] };
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const p: Vec3 = [flat[i], flat[i + 1], flat[i + 2]];
    const c = flat[i + 3];
    if (c === CLS_WINDOW) out.window.push(p);
    else if (c === CLS_DOOR) out.door.push(p);
    else if (c === CLS_FLOOR) out.floor.push(p);
  }
  return out;
}

const sameOpening = (a: { centre: Vec3; normal: Vec3 }, b: { centre: Vec3; normal: Vec3 }) =>
  dist(a.centre, b.centre) < MATCH_M && Math.abs(dot(a.normal, b.normal)) > 0.9;

/**
 * New detections merged into the running list: a match keeps its id,
 * votes and vista and takes the new geometry. Openings the mesh no longer
 * shows stay (the mesh flickers; a window seen once is still a window).
 */
export function mergeOpenings(prev: Opening[], flat: number[], roomCentre: Vec3): Opening[] {
  const pts = splitPoints(flat);
  const out = prev.map((o) => ({ ...o }));
  let next = prev.reduce((m, o) => Math.max(m, Number(o.id.slice(1)) || 0), 0);
  for (const kind of ['window', 'door'] as const) {
    for (const cl of clusterPoints(pts[kind])) {
      const r = rectFromPoints(cl, roomCentre);
      if (!r) continue;
      const hit = out.find((o) => o.kind !== 'manual' && sameOpening(o, r));
      if (hit) Object.assign(hit, r, { kind });
      else out.push({ ...r, id: `o${++next}`, kind, seen: 0, clipped: 0, vista: null });
    }
  }
  return out;
}

/** Manual opening from four tapped points on its frame (any order). */
export function manualOpening(prev: Opening[], taps: Vec3[], roomCentre: Vec3): Opening[] | null {
  const r = rectFromPoints(taps, roomCentre, 4);
  if (!r) return null;
  const next = prev.reduce((m, o) => Math.max(m, Number(o.id.slice(1)) || 0), 0) + 1;
  return [...prev, { ...r, id: `o${next}`, kind: 'manual', seen: 0, clipped: 0, vista: null }];
}

/** 4x4 points inside the rectangle (15 % inset) for the luma check. */
export function lumaSamples(o: Opening): Vec3[] {
  const [tl, tr, , bl] = o.corners;
  const ux = sub(tr, tl);
  const uy = sub(bl, tl);
  const out: Vec3[] = [];
  for (const a of [0.15, 0.38, 0.62, 0.85]) for (const b of [0.15, 0.38, 0.62, 0.85]) {
    out.push(add(add(tl, mul(ux, a)), mul(uy, b)));
  }
  return out;
}

/**
 * Share of the image the opening covers seen from `eye` (pinhole, facing it
 * square on: an upper bound). Recording runs on auto exposure, so the vote
 * below only means something while the glass is a small part of the frame
 * and the room sets the exposure; filling the frame, the camera exposes for
 * the glass and the view outside stops clipping.
 */
export function imageFraction(o: Opening, eye: Vec3, focal: number, imgW: number, imgH: number): number {
  const d = dist(o.centre, eye);
  if (d <= 0 || imgW <= 0 || imgH <= 0) return 1;
  const w = (o.width * focal) / d;
  const h = (o.height * focal) / d;
  return Math.min(1, (Math.min(w, imgW) * Math.min(h, imgH)) / (imgW * imgH));
}

/** Larger than this in the image and the glass would steer auto exposure. */
export const MAX_VOTE_FRACTION = 0.15;

/**
 * Glass this much brighter than the frame (medians) looks outside. Measured on
 * device scan 1791032313077 (auto exposure, day): per look, ratio >= 1.3 in
 * 71-100% of looks for 8 windows, 13-33% for 3 doors. The old rule (most
 * glass samples clipped) was made for a locked exposure; under auto exposure
 * no window reached it (best 31%), so nothing was exterior and the vista pass
 * fell back to a half sphere that pointed into the room.
 */
export const EXTERIOR_RATIO = 1.3;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/**
 * World points that land on a 5 x 5 grid over the camera image (10-90 %), 1 m
 * ahead: sampleLuma() of these gives the frame's brightness. T column-major
 * camera-to-world; ARKit image: u along camera +x, v along camera -y.
 */
export function frameSamples(T: number[], focal: number, imgW: number, imgH: number): Vec3[] {
  const out: Vec3[] = [];
  for (const fv of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fu of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const c: Vec3 = [((fu - 0.5) * imgW) / focal, (-(fv - 0.5) * imgH) / focal, -1];
    out.push([
      T[0] * c[0] + T[4] * c[1] + T[8] * c[2] + T[12],
      T[1] * c[0] + T[5] * c[1] + T[9] * c[2] + T[13],
      T[2] * c[0] + T[6] * c[1] + T[10] * c[2] + T[14],
    ]);
  }
  return out;
}

/**
 * One look at the glass while the room sets the (auto) exposure; see
 * imageFraction. `luma` has -1 for samples out of view; `frameLuma` is the
 * frame grid (frameSamples). An "outside" vote: most glass samples clipped,
 * or the glass EXTERIOR_RATIO times brighter than the frame.
 */
export function voteExterior(o: Opening, luma: number[], frameLuma: number[] = []): Opening {
  const valid = luma.filter((v) => v >= 0);
  if (valid.length < MIN_LUMA_SAMPLES) return o;
  const clip = valid.filter((v) => v >= CLIP_LUMA).length / valid.length;
  const frame = frameLuma.filter((v) => v >= 0);
  const bright = frame.length >= 13 && median(valid) >= EXTERIOR_RATIO * Math.max(1, median(frame));
  return { ...o, seen: o.seen + 1, clipped: o.clipped + (clip > 0.5 || bright ? 1 : 0) };
}

export const isExterior = (o: Opening) => o.seen > 0 && o.clipped * 2 >= o.seen;

/**
 * Floor height: 10th percentile of floor points; without any, a hand-held
 * phone is about 1.45 m above the floor.
 */
export function floorHeight(floorPts: Vec3[], path: Vec3[]): number | null {
  if (floorPts.length >= 20) {
    const ys = floorPts.map((p) => p[1]).sort((a, b) => a - b);
    return ys[Math.floor(ys.length * 0.1)];
  }
  if (path.length === 0) return null;
  return Math.min(...path.map((p) => p[1])) - 1.45;
}

/** Can a person walk through it: a door, or a tall opening reaching the floor. */
export function isTraversable(o: Opening, floorY: number | null): boolean {
  if (o.kind === 'door') return true;
  if (floorY === null) return false;
  return o.height >= 1.6 && o.centre[1] - o.height / 2 < floorY + 0.35;
}

/**
 * The phone moved from prev to cur: did it pass through the opening's
 * rectangle (grown by `margin`)? 'out' = room side to the far side.
 */
export function crossing(prev: Vec3, cur: Vec3, o: Opening, margin = 0.25): 'out' | 'in' | null {
  const s0 = dot(sub(prev, o.centre), o.normal);
  const s1 = dot(sub(cur, o.centre), o.normal);
  if ((s0 < 0) === (s1 < 0)) return null;
  const t = s0 / (s0 - s1);
  const hit = add(prev, mul(sub(cur, prev), t));
  const right = cross(o.normal, UP);
  const d = sub(hit, o.centre);
  if (Math.abs(dot(d, right)) > o.width / 2 + margin) return null;
  if (Math.abs(d[1]) > o.height / 2 + margin) return null;
  return s1 >= 0 ? 'out' : 'in';
}

/**
 * Past the doorway by this much before the segment switches. Small on
 * purpose: a phone held out through the door does switch, but pulling it
 * back switches again. Segments are labels only (exposure is auto).
 */
export const COMMIT_M = 0.1;

export type DoorwayState = { pending: { id: string; dir: 'out' | 'in' } | null };

/**
 * Walking through a door, step by step. Passing through a traversable
 * opening's rectangle only arms a switch; it fires once the phone is
 * COMMIT_M beyond the door plane, and is dropped if the phone comes back to
 * the side it started on first (jitter right at the door plane).
 * Decided by position alone, never by brightness: a bright spot inside the
 * room stays an indoor segment.
 */
export function doorwayStep(
  state: DoorwayState, prev: Vec3, cur: Vec3, openings: Opening[], floorY: number | null,
): { state: DoorwayState; switchTo: 'out' | 'in' | null } {
  const p = state.pending;
  if (p) {
    const o = openings.find((x) => x.id === p.id);
    if (!o) return { state: { pending: null }, switchTo: null };
    const s = dot(sub(cur, o.centre), o.normal);
    if (p.dir === 'out') {
      if (s >= COMMIT_M) return { state: { pending: null }, switchTo: 'out' };
      if (s < 0) return { state: { pending: null }, switchTo: null };
    } else {
      if (s <= -COMMIT_M) return { state: { pending: null }, switchTo: 'in' };
      if (s > 0) return { state: { pending: null }, switchTo: null };
    }
    return { state, switchTo: null };
  }
  for (const o of openings) {
    if (!isTraversable(o, floorY)) continue;
    const c = crossing(prev, cur, o);
    if (c) return doorwayStep({ pending: { id: o.id, dir: c } }, prev, cur, openings, floorY);
  }
  return { state, switchTo: null };
}

/**
 * Exterior openings facing the way the phone looks (within 70 deg, level).
 * None voted exterior (night, few looks): windows facing that way -- the user
 * asked for a vista while looking at one; a half sphere around the heading
 * would point back into the room.
 */
export function openingsFacing(openings: Opening[], forward: Vec3): Opening[] {
  const h = Math.hypot(forward[0], forward[2]);
  if (h < 1e-6) return [];
  const f: Vec3 = [forward[0] / h, 0, forward[2] / h];
  const facing = openings.filter((o) => dot(o.normal, f) >= Math.cos((70 * Math.PI) / 180));
  const ext = facing.filter(isExterior);
  return ext.length ? ext : facing.filter((o) => o.kind === 'window');
}

const SHOT_PITCHES = [-50, -25, 0, 25, 50];
const SHOT_YAW_STEP = 30;
/** A shot direction is needed when a visible direction lies this close to it. */
const SHOT_REACH_DEG = 22;

function directions(pitches: number[], yawStep: number): Vec3[] {
  const out: Vec3[] = [];
  for (const p of pitches) {
    const pr = (p * Math.PI) / 180;
    for (let y = 0; y < 360; y += yawStep) {
      const yr = (y * Math.PI) / 180;
      out.push([Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)]);
    }
  }
  return out;
}

const FINE = directions(Array.from({ length: 33 }, (_, i) => -80 + i * 5), 5);
const SHOTS = directions(SHOT_PITCHES, SHOT_YAW_STEP);

function rayHitsOpening(eye: Vec3, d: Vec3, o: Opening): boolean {
  const den = dot(d, o.normal);
  if (den <= 1e-6) return false; // must travel outwards
  const t = dot(sub(o.centre, eye), o.normal) / den;
  if (t <= 0) return false;
  const hit = add(eye, mul(d, t));
  const dd = sub(hit, o.centre);
  return Math.abs(dot(dd, cross(o.normal, UP))) <= o.width / 2 && Math.abs(dd[1]) <= o.height / 2;
}

/**
 * Directions a vista must cover. Outside (balcony, terrace): the half-space
 * in front of the facade, grazing angles left out. Inside: every direction
 * in which some point of the walked path sees through one of the openings.
 * Visible directions are found on a 5 deg grid; the shots are the points of
 * the coarse shot grid (30 deg) that have a visible direction within
 * SHOT_REACH_DEG (a photo spans about 60 deg, so a narrow window cone still
 * gets its shots).
 * Null when fewer than 4 are needed (nothing detected yet): the caller falls
 * back to the fixed half-sphere grid (vistaTargets.makeTargets).
 */
export function visibleTargets(openings: Opening[], path: Vec3[], outdoor: boolean): Vec3[] | null {
  if (openings.length === 0) return null;
  let seen: Vec3[];
  if (outdoor) {
    seen = FINE.filter((d) => openings.some((o) => dot(d, o.normal) > 0.17));
  } else {
    const step = Math.max(1, Math.ceil(path.length / 60));
    const eyes = path.filter((_, i) => i % step === 0);
    seen = FINE.filter((d) => eyes.some((e) => openings.some((o) => rayHitsOpening(e, d, o))));
  }
  const reach = Math.cos((SHOT_REACH_DEG * Math.PI) / 180);
  const out = SHOTS.filter((s) => seen.some((d) => dot(s, d) >= reach));
  return out.length >= 4 ? out : null;
}

/** Exterior openings still without a vista, in list order. */
export const missingVistas = (openings: Opening[]) => openings.filter((o) => isExterior(o) && !o.vista);

/** Display names: "Pencere 1", "Kapı 1", "Elle 1" in detection order. */
export function openingNames(openings: Opening[]): Map<string, string> {
  const count: Record<OpeningKind, number> = { window: 0, door: 0, manual: 0 };
  const word: Record<OpeningKind, string> = { window: 'Pencere', door: 'Kapı', manual: 'Elle' };
  const out = new Map<string, string>();
  for (const o of openings) out.set(o.id, `${word[o.kind]} ${++count[o.kind]}`);
  return out;
}

/** openings_hint.json body (ARKit world, metres). */
export function openingsHint(openings: Opening[], floorY: number | null) {
  return {
    version: 1,
    space: 'arkit_world',
    floor_y: floorY,
    openings: openings.map((o) => ({
      id: o.id,
      source: o.kind === 'manual' ? 'manual' : 'arkit',
      kind: o.kind,
      corners: o.corners,
      normal: o.normal,
      width_m: o.width,
      height_m: o.height,
      exterior: isExterior(o),
      votes: { seen: o.seen, clipped: o.clipped },
      traversable: isTraversable(o, floorY),
      vista: o.vista,
    })),
  };
}
