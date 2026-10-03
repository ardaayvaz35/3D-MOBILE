/**
 * Object mode on the scan screen (spec 2026-10-02-uygulama-mimarisi.md §3.2-3.6):
 * RoomPlan's furniture, the mode machine (room -> black -> object -> black ->
 * room), each piece's dome, and the two arrows' targets -- the walk arrow's
 * route on the floor and the camera arrow's aim point.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  GuidancePayload,
  ObjectsPayload,
  PosePayload,
  RoomPlanObject,
  RoomPlanWall,
} from '../../modules/arkit-capture/src/ArkitCapture.types';
import { onObjects, onPose, setCaptureMode, setObjectBoxes } from '../native/arkitCapture';
import {
  angleDeg,
  approachPoint,
  AIM_DEG,
  ENTER_M,
  displayName,
  domeComplete,
  domeProgress,
  exportBox,
  footprintDistance,
  makeDome,
  type ModeState,
  nativeMode,
  nextSlice,
  refreshDome,
  RETURN_HINT_AFTER_S,
  type Room,
  type Slice,
  sliceFor,
  sliceHint,
  stepMode,
  type Vec3,
  wantsOwnScan,
} from './objectMode';
import { buildGrid, findPath, type Grid, isFreeAt } from './walkPath';

const ROUTE_EVERY_S = 0.5;
/** The floor map (and with it which dome slices a person can reach) is rebuilt this often. */
const GRID_EVERY_S = 2;
/** From this much of the dome the finish button says "tamam" instead of "bitir". */
export const FINISH_OFFER = 0.7;

const pos = (T: number[]): Vec3 => [T[12], T[13], T[14]];
const fwdOf = (T: number[]): Vec3 => [-T[8], -T[9], -T[10]];

/** Inverse of vistaTargets.toScreen: portrait screen direction -> world. */
export function fromScreen(d: { right: number; up: number; forward: number }, T: number[]): Vec3 {
  const c = [-d.up, d.right, -d.forward]; // camera frame (see toScreen)
  return [
    T[0] * c[0] + T[4] * c[1] + T[8] * c[2],
    T[1] * c[0] + T[5] * c[1] + T[9] * c[2],
    T[2] * c[0] + T[6] * c[1] + T[10] * c[2],
  ];
}

export type ObjectModeView = {
  state: ModeState;
  current: RoomPlanObject | null;
  currentName: string;
  dome: Slice[];
  progress: number;
  objects: { o: RoomPlanObject; name: string; done: boolean }[];
  pendingNames: string[];
  finderStatus: string;
  /** Floor route for the walk arrow (x, z; y = floor), null = arrow hidden. */
  route: Vec3[] | null;
  /** World point the camera arrow aims at in object mode. */
  aim: Vec3 | null;
  hint: string | null;
  /** Black screen: text + metres above (+) / below (-) the room height. */
  black: { text: string; heightDev: number; showBar: boolean } | null;
};

export function useObjectMode(
  recording: boolean,
  guide: GuidancePayload | null,
  frameCount: number,
  floor: { floorY: () => number | null; floorPoints: () => Vec3[]; walkedPath: () => Vec3[] },
) {
  const [, setTick] = useState(0);
  const objects = useRef(new Map<string, RoomPlanObject>());
  const walls = useRef<RoomPlanWall[]>([]);
  const status = useRef('off');
  const done = useRef(new Set<string>());
  const domes = useRef(new Map<string, Slice[]>());
  const scanned = useRef(new Set<string>());
  const state = useRef<ModeState>({ kind: 'room' });
  const finishAsked = useRef(false);
  const lastFrames = useRef(0);
  const framesNow = useRef(0);
  const guideRef = useRef<GuidancePayload | null>(null);
  const poseRef = useRef<PosePayload | null>(null);
  const route = useRef<Vec3[] | null>(null);
  const lastRoute = useRef(0);
  const grid = useRef<Grid | null>(null);
  const lastGrid = useRef(0);
  const sentMode = useRef('');
  /**
   * Room lock height (ARKit y), from guidance payloads: lock = y - heightDeviation.
   * On the black screens the native side skips the frame path, guidance
   * included, so heightDeviation froze and the way back to room mode never
   * opened (device test 2026-10-03). The live pose still arrives; the
   * deviation there is pose y minus this.
   */
  const lockSamples = useRef<number[]>([]);
  const lockY = useRef<number | null>(null);
  const lastGuide = useRef<GuidancePayload | null>(null);

  guideRef.current = guide;
  framesNow.current = frameCount;

  const reset = () => {
    objects.current.clear();
    walls.current = [];
    status.current = 'off';
    done.current.clear();
    domes.current.clear();
    scanned.current.clear();
    state.current = { kind: 'room' };
    finishAsked.current = false;
    lastFrames.current = 0;
    route.current = null;
    grid.current = null;
    lastGrid.current = 0;
    sentMode.current = '';
    lockSamples.current = [];
    lockY.current = null;
    lastGuide.current = null;
    setTick((t) => t + 1);
  };

  useEffect(
    () =>
      onObjects((p: ObjectsPayload) => {
        status.current = p.status;
        // Keep a piece RoomPlan stops listing (it was there); refresh the rest.
        for (const o of p.objects ?? []) objects.current.set(o.id, o);
        if (p.walls?.length) walls.current = p.walls;
      }),
    []
  );

  const pending = () =>
    [...objects.current.values()].filter((o) => wantsOwnScan(o) && !done.current.has(o.id));

  const room = (): Room => {
    const g = grid.current;
    return { free: g ? (p) => isFreeAt(g, p) : undefined, floorY: floor.floorY() };
  };

  const applyNative = () => {
    const n = nativeMode(state.current);
    const tag = `${n.mode}:${n.objectId ?? ''}`;
    if (tag === sentMode.current) return;
    sentMode.current = tag;
    setCaptureMode(n.mode, n.objectId);
  };

  useEffect(() => {
    if (!recording) return;
    return onPose((p) => {
      poseRef.current = p;
      const now = Date.now() / 1000;
      const T = p.transform;
      const here = pos(T);
      const g = guideRef.current;
      // A fresh guidance payload paired with the newest pose: one lock sample.
      if (g && g !== lastGuide.current) {
        lastGuide.current = g;
        const k = lockSamples.current;
        k.push(here[1] - g.heightDeviation);
        if (k.length > 40) k.shift();
        lockY.current = [...k].sort((a, b) => a - b)[k.length >> 1];
      }
      const heightDev = lockY.current !== null ? here[1] - lockY.current : g?.heightDeviation ?? 0;
      const eyeY = here[1] - heightDev;
      const s0 = state.current;

      // Floor map: where a person can stand, so only reachable slices count.
      if (now - lastGrid.current >= GRID_EVERY_S) {
        lastGrid.current = now;
        grid.current = buildGrid(floor.floorPoints(), floor.walkedPath(), [...objects.current.values()], walls.current);
        if (s0.kind === 'object') {
          const o = objects.current.get(s0.id);
          const d = domes.current.get(s0.id);
          if (o && d) refreshDome(d, o, room());
        }
      }

      // Fill the dome from frames actually kept (frame count went up).
      if (s0.kind === 'object') {
        const o = objects.current.get(s0.id);
        const dome = domes.current.get(s0.id);
        if (o && dome && framesNow.current > lastFrames.current) {
          const i = sliceFor(dome, o, here, fwdOf(T));
          if (i >= 0) dome[i].filled = true;
        }
      }
      lastFrames.current = framesNow.current;

      const cur = s0.kind === 'room' ? null : objects.current.get(s0.id) ?? null;
      const dome = cur ? domes.current.get(cur.id) ?? [] : [];
      const complete = finishAsked.current || (s0.kind === 'object' && domeComplete(dome));
      const s1 = stepMode(s0, { now, pos: here, fwd: fwdOf(T), pending: pending(), complete, heightDev });

      if (s1 !== s0) {
        if (s1.kind === 'object') {
          const o = objects.current.get(s1.id);
          if (o && !domes.current.has(o.id)) domes.current.set(o.id, makeDome(o, eyeY, walls.current, room()));
          scanned.current.add(s1.id);
          setObjectBoxes([...scanned.current].map((id) => objects.current.get(id)).filter(Boolean).map((o) => exportBox(o!)));
        }
        if (s1.kind === 'toRoom') {
          done.current.add(s1.id);
          finishAsked.current = false;
        }
        state.current = s1;
        applyNative();
      }

      // Walk arrow route, a couple of times a second.
      if (now - lastRoute.current >= ROUTE_EVERY_S) {
        lastRoute.current = now;
        route.current = planRoute(state.current, here, T, g);
      }
      setTick((t) => (t + 1) % 1_000_000);
    });
  }, [recording]);

  function planRoute(s: ModeState, here: Vec3, T: number[], g: GuidancePayload | null): Vec3[] | null {
    let target: Vec3 | null = null;
    if (s.kind === 'object') {
      const o = objects.current.get(s.id);
      const dome = domes.current.get(s.id);
      if (o && dome) {
        const i = nextSlice(dome, o, here);
        // Close to the spot already: the camera arrow and the text take over.
        if (i >= 0 && Math.hypot(dome[i].cam[0] - here[0], dome[i].cam[2] - here[2]) > 0.4) target = dome[i].cam;
      }
    } else if (s.kind === 'room') {
      // Spec §3.2: the walk arrow shows only once turning on the spot has nothing left.
      const free = !g || g.mode === 'walk' || g.mode === 'wait' || g.done;
      if (!free) return null;
      const list = pending();
      if (list.length) {
        const o = list.reduce((a, b) => (footprintDistance(here, a) <= footprintDistance(here, b) ? a : b));
        target = approachPoint(o, here);
      } else if (g?.mode === 'walk' && g.walk && g.walkMeters) {
        const d = fromScreen(g.walk, T);
        target = [here[0] + d[0] * g.walkMeters, 0, here[2] + d[2] * g.walkMeters];
      }
    }
    if (!target) return null;
    const grid = buildGrid(floor.floorPoints(), floor.walkedPath(), [...objects.current.values()], walls.current);
    const path = grid ? findPath(grid, here, target) : null;
    return path ?? [[here[0], 0, here[2]], [target[0], 0, target[2]]];
  }

  const s = state.current;
  const p = poseRef.current;
  const here = p ? pos(p.transform) : null;
  const cur = s.kind === 'room' ? null : objects.current.get(s.id) ?? null;
  const curName = cur ? displayName(cur) : '';
  const dome = cur ? domes.current.get(cur.id) ?? [] : [];
  const heightDev = here && lockY.current !== null ? here[1] - lockY.current : guide?.heightDeviation ?? 0;

  let hint: string | null = null;
  let aim: Vec3 | null = null;
  if (s.kind === 'object' && cur && here && p) {
    aim = cur.center;
    const i = nextSlice(dome, cur, here);
    const toObj = angleDeg(fwdOf(p.transform), [cur.center[0] - here[0], cur.center[1] - here[1], cur.center[2] - here[2]]);
    hint =
      (i >= 0 ? sliceHint(dome[i], here, cur) : null) ??
      (toObj > AIM_DEG ? `${curName}'e çevir` : `${curName}: etrafında yavaşça dolaş`);
  } else if (s.kind === 'room' && here && p) {
    const list = pending();
    const eyed = s.eyeing ? objects.current.get(s.eyeing.id) : null;
    const close = list.find((o) => footprintDistance(here, o) <= ENTER_M);
    if (eyed) hint = `${displayName(eyed)} taraması başlıyor…`;
    else if (close) hint = `${displayName(close)}: taramak için telefonu ona çevir`;
    else if (list.length && route.current) {
      const o = list.reduce((a, b) => (footprintDistance(here, a) <= footprintDistance(here, b) ? a : b));
      hint = `${displayName(o)} bulundu, yanına git`;
    }
  }

  let black: ObjectModeView['black'] = null;
  if (s.kind === 'toObject') {
    const name = displayName(objects.current.get(s.id)!);
    black = { text: `${name} taraması başlıyor.\nYükseklik serbest, etrafında dolaş.`, heightDev, showBar: false };
  } else if (s.kind === 'toRoom') {
    const name = displayName(objects.current.get(s.id)!);
    const long = Date.now() / 1000 - s.since > RETURN_HINT_AFTER_S;
    const dir = heightDev > 0 ? 'Telefonu biraz indir' : 'Telefonu biraz kaldır';
    black = {
      text: `${name} taraması tamamlandı.\n${long ? dir : 'Telefonu ekrandaki yüksekliğe getir'}`,
      heightDev,
      showBar: true,
    };
  }

  const all = [...objects.current.values()].filter(wantsOwnScan);
  const view: ObjectModeView = {
    state: s,
    current: cur,
    currentName: curName,
    dome,
    progress: domeProgress(dome),
    objects: all.map((o) => ({ o, name: displayName(o), done: done.current.has(o.id) })),
    pendingNames: all.filter((o) => !done.current.has(o.id)).map(displayName),
    finderStatus: status.current,
    route: s.kind === 'room' || s.kind === 'object' ? route.current : null,
    aim,
    hint,
    black,
  };

  return {
    ...view,
    reset,
    /** The user ends the current piece early (offered from FINISH_OFFER). */
    finishCurrent: () => {
      finishAsked.current = true;
    },
    /** Leave a piece out of the tour's walk-arounds. */
    skip: (id: string) => {
      done.current.add(id);
      setTick((t) => t + 1);
    },
  };
}
