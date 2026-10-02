/**
 * The walk arrow's route on the floor (spec 2026-10-02-uygulama-mimarisi.md
 * §3.2, two arrows). The old hint pointed straight at the average of the
 * missing places and could lead through the bed; this plans on a floor grid
 * instead: cells the LiDAR classified as floor (or the phone walked over) are
 * free, RoomPlan's furniture boxes and walls are not, and A* finds the way.
 *
 * Pure math, ARKit world (+Y up, metres); only x and z matter here.
 */
import type { RoomPlanObject, RoomPlanWall } from '../../modules/arkit-capture/src/ArkitCapture.types';
import type { Vec3 } from './objectMode';

export const CELL_M = 0.1;
/** A floor point frees the cells within this radius (floor faces are thinned). */
const FLOOR_RADIUS_M = 0.25;
/** Kept clear of furniture and walls: half a body width. */
export const BODY_M = 0.25;
/** Goal snapped to the nearest free cell within this. */
const SNAP_M = 1.0;
const MAX_CELLS = 250_000;

export type Grid = { x0: number; z0: number; nx: number; nz: number; free: Uint8Array };

const key = (g: Grid, i: number, k: number) => k * g.nx + i;

function cellOf(g: Grid, p: Vec3): [number, number] {
  return [Math.floor((p[0] - g.x0) / CELL_M), Math.floor((p[2] - g.z0) / CELL_M)];
}

const centre = (g: Grid, i: number, k: number): Vec3 => [g.x0 + (i + 0.5) * CELL_M, 0, g.z0 + (k + 0.5) * CELL_M];

/** Inside a box footprint grown by `pad`? */
function inBox(p: Vec3, o: RoomPlanObject, pad: number): boolean {
  const c = Math.cos((o.yaw_deg * Math.PI) / 180);
  const s = Math.sin((o.yaw_deg * Math.PI) / 180);
  const dx = p[0] - o.center[0];
  const dz = p[2] - o.center[2];
  const lx = dx * c - dz * s; // along box x = (c, 0, -s)
  const lz = dx * s + dz * c; // along box z = (s, 0, c)
  return Math.abs(lx) <= o.size[0] / 2 + pad && Math.abs(lz) <= o.size[2] / 2 + pad;
}

function nearWall(p: Vec3, w: RoomPlanWall, pad: number): boolean {
  const c = Math.cos((w.yaw_deg * Math.PI) / 180);
  const s = Math.sin((w.yaw_deg * Math.PI) / 180);
  const dx = p[0] - w.center[0];
  const dz = p[2] - w.center[2];
  const along = dx * c - dz * s;
  const across = dx * s + dz * c;
  return Math.abs(along) <= w.width / 2 && Math.abs(across) <= pad;
}

export function buildGrid(
  floor: Vec3[], walked: Vec3[], objects: RoomPlanObject[], walls: RoomPlanWall[],
): Grid | null {
  const pts = [...floor, ...walked];
  if (pts.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const x0 = minX - 1, z0 = minZ - 1;
  const nx = Math.ceil((maxX - minX + 2) / CELL_M);
  const nz = Math.ceil((maxZ - minZ + 2) / CELL_M);
  if (nx * nz > MAX_CELLS) return null;
  const g: Grid = { x0, z0, nx, nz, free: new Uint8Array(nx * nz) };
  const r = Math.ceil(FLOOR_RADIUS_M / CELL_M);
  for (const p of pts) {
    const [ci, ck] = cellOf(g, p);
    for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
      if (di * di + dk * dk > r * r) continue;
      const i = ci + di, k = ck + dk;
      if (i >= 0 && k >= 0 && i < nx && k < nz) g.free[key(g, i, k)] = 1;
    }
  }
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const idx = key(g, i, k);
    if (!g.free[idx]) continue;
    const p = centre(g, i, k);
    if (objects.some((o) => inBox(p, o, BODY_M)) || walls.some((w) => nearWall(p, w, BODY_M))) g.free[idx] = 0;
  }
  return g;
}

function nearestFree(g: Grid, i: number, k: number, maxR: number): [number, number] | null {
  for (let r = 0; r <= maxR; r++) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dk)) !== r) continue;
      const a = i + di, b = k + dk;
      if (a < 0 || b < 0 || a >= g.nx || b >= g.nz || !g.free[key(g, a, b)]) continue;
      const d = di * di + dk * dk;
      if (d < bestD) { bestD = d; best = [a, b]; }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Route from `from` to `to` (x, z; y ignored) or null. The start cell counts
 * as free (the phone is where it is); the goal snaps to the nearest free cell
 * within SNAP_M. 8-connected A*, no corner cutting.
 */
export function findPath(g: Grid, from: Vec3, to: Vec3): Vec3[] | null {
  let [si, sk] = cellOf(g, from);
  si = Math.max(0, Math.min(g.nx - 1, si));
  sk = Math.max(0, Math.min(g.nz - 1, sk));
  const [gi0, gk0] = cellOf(g, to);
  const goal = nearestFree(g, Math.max(0, Math.min(g.nx - 1, gi0)), Math.max(0, Math.min(g.nz - 1, gk0)),
    Math.ceil(SNAP_M / CELL_M));
  if (!goal) return null;
  const [gi, gk] = goal;
  const N = g.nx * g.nz;
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const start = key(g, si, sk);
  const target = key(g, gi, gk);
  cost[start] = 0;
  // Binary heap of [f, idx].
  const heap: [number, number][] = [];
  const push = (f: number, idx: number) => {
    heap.push([f, idx]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const h = (i: number, k: number) => Math.hypot(i - gi, k - gk);
  push(h(si, sk), start);
  const free = (i: number, k: number) =>
    i >= 0 && k >= 0 && i < g.nx && k < g.nz && (g.free[key(g, i, k)] === 1 || key(g, i, k) === start);
  while (heap.length) {
    const [, idx] = pop();
    if (closed[idx]) continue;
    closed[idx] = 1;
    if (idx === target) break;
    const i = idx % g.nx, k = Math.floor(idx / g.nx);
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      if (!di && !dk) continue;
      const a = i + di, b = k + dk;
      if (!free(a, b)) continue;
      if (di && dk && (!free(i + di, k) || !free(i, k + dk))) continue;
      const n = key(g, a, b);
      const c = cost[idx] + (di && dk ? Math.SQRT2 : 1);
      if (c < cost[n]) {
        cost[n] = c;
        prev[n] = idx;
        push(c + h(a, b), n);
      }
    }
  }
  if (!closed[target]) return null;
  const cells: number[] = [];
  for (let c = target; c !== -1; c = prev[c]) cells.push(c);
  cells.reverse();
  return cells.map((c) => centre(g, c % g.nx, Math.floor(c / g.nx)));
}

/** Points every `step` metres along a polyline, starting at its first point. */
export function resample(path: Vec3[], step: number, maxLen: number): Vec3[] {
  if (path.length === 0) return [];
  const out: Vec3[] = [path[0]];
  let walked = 0; // distance from path[0] to the start of the current segment
  let next = step; // distance of the next point to emit
  for (let j = 1; j < path.length && next <= maxLen; j++) {
    const a = path[j - 1], b = path[j];
    const seg = Math.hypot(b[0] - a[0], b[2] - a[2]);
    while (seg > 0 && next <= walked + seg && next <= maxLen) {
      const t = (next - walked) / seg;
      out.push([a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t]);
      next += step;
    }
    walked += seg;
  }
  return out;
}
