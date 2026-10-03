/**
 * Window / balcony part of a LiDAR recording (spec 2026-09-30-pencere-manzara-design.md §4):
 * live openings list with the inside/outside vote, an outdoor segment label
 * when the phone walks through a door (button as fallback), manual
 * openings by tapping four corners, and the guided vista pass whose targets
 * are the directions visible through the openings it covers.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  beginSegment,
  captureVistaShot,
  classifiedPoints,
  endVista,
  onPose,
  raycast,
  sampleLuma,
  setOpeningsHint,
  setWindowExposurePoint,
  startVista,
} from '../native/arkitCapture';
import type { GuidancePayload, PosePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';
import { ALIGN_DEG, angleDeg, holdStep, makeTargets, nextTarget, toScreen, type Vec3 } from './vistaTargets';
import {
  centroid,
  doorwayStep,
  type DoorwayState,
  floorHeight,
  imageFraction,
  lumaSamples,
  MAX_VOTE_FRACTION,
  manualOpening,
  mergeOpenings,
  missingVistas,
  openingNames,
  openingsFacing,
  openingsHint,
  splitPoints,
  visibleTargets,
  voteExterior,
  frameSamples,
  type Opening,
} from './openings';

type Role = 'vista' | 'control';
const LUMA_RANGE_M = 6; // glass further than this is too small in the image to vote
const PATH_STEP_M = 0.25;

const pos = (T: number[]): Vec3 => [T[12], T[13], T[14]];
const fwdOf = (T: number[]): Vec3 => [-T[8], -T[9], -T[10]];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function useVistaCapture(recording: boolean, size: { width: number; height: number }) {
  const [pose, setPose] = useState<PosePayload | null>(null);
  const [outdoor, setOutdoor] = useState(false);
  const [segmentBusy, setSegmentBusy] = useState(false);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [vistaRole, setVistaRole] = useState<Role | null>(null);
  const [vistaDone, setVistaDone] = useState(0);
  const [vistaTotal, setVistaTotal] = useState(0);
  const [addTaps, setAddTaps] = useState<Vec3[] | null>(null); // null = not adding

  const openingsRef = useRef<Opening[]>([]);
  const floorY = useRef<number | null>(null);
  const indoorPath = useRef<Vec3[]>([]);
  const floorPts = useRef<Vec3[]>([]);
  const lastPos = useRef<Vec3 | null>(null);
  const poseRef = useRef<PosePayload | null>(null);
  const outdoorRef = useRef(false);
  const busyRef = useRef(false);
  const wantOutdoor = useRef(false);
  const doorway = useRef<DoorwayState>({ pending: null });
  const vistaRoleRef = useRef<Role | null>(null);
  const vistaId = useRef('');
  const vistaOpeningIds = useRef<string[]>([]);
  const targets = useRef<Vec3[]>([]);
  const done = useRef<boolean[]>([]);
  const hold = useRef({ held: 0 });
  const shooting = useRef(false);
  const lastPoseT = useRef(0);

  const putOpenings = (list: Opening[]) => {
    openingsRef.current = list;
    setOpenings(list);
  };
  const roomCentre = (): Vec3 =>
    indoorPath.current.length ? centroid(indoorPath.current) : lastPos.current ?? [0, 0, 0];

  /** Fresh state for a new recording (called by the screen on Start). */
  const reset = () => {
    putOpenings([]);
    floorY.current = null;
    indoorPath.current = [];
    floorPts.current = [];
    lastPos.current = null;
    doorway.current = { pending: null };
    wantOutdoor.current = false;
    outdoorRef.current = false;
    setOutdoor(false);
    vistaRoleRef.current = null;
    setVistaRole(null);
    setAddTaps(null);
  };

  const switchSegment = async (toOutdoor: boolean) => {
    if (busyRef.current || outdoorRef.current === toOutdoor) return;
    busyRef.current = true;
    setSegmentBusy(true);
    try {
      await beginSegment(toOutdoor);
      outdoorRef.current = toOutdoor;
      setOutdoor(toOutdoor);
    } catch (e: any) {
      Alert.alert('Bölüm değiştirilemedi', e?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setSegmentBusy(false);
    }
  };

  // Pose: walked path (room side only), door crossings.
  useEffect(
    () =>
      onPose((p) => {
        poseRef.current = p;
        setPose(p);
        if (!recording) return;
        const cur = pos(p.transform);
        const prev = lastPos.current;
        lastPos.current = cur;
        if (!outdoorRef.current && !p.paused) {
          const path = indoorPath.current;
          if (!path.length || dist(path[path.length - 1], cur) >= PATH_STEP_M) {
            path.push(cur);
            if (path.length > 2000) path.splice(0, path.length - 2000);
          }
        }
        if (!prev || vistaRoleRef.current) return;
        // Followed even while a switch is metering, so a quick out-and-back is
        // never missed; the wanted side is applied as soon as the camera is free.
        const step = doorwayStep(doorway.current, prev, cur, openingsRef.current, floorY.current);
        doorway.current = step.state;
        if (step.switchTo) wantOutdoor.current = step.switchTo === 'out';
        if (!busyRef.current && wantOutdoor.current !== outdoorRef.current) void switchSegment(wantOutdoor.current);
      }),
    [recording]
  );

  // Openings: about once a second while recording, not during a vista pass.
  useEffect(() => {
    if (!recording || vistaRole) return;
    let alive = true;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const flat = await classifiedPoints();
        if (!alive) return;
        const floor = splitPoints(flat).floor;
        floorPts.current = floor;
        const fy = floorHeight(floor, indoorPath.current);
        if (fy !== null) floorY.current = fy;
        let list = mergeOpenings(openingsRef.current, flat, roomCentre());
        // Inside/outside vote only from the room side and only for glass that is
        // a small part of the frame: auto exposure is then set by the room.
        const here = lastPos.current;
        const cam = poseRef.current;
        if (!outdoorRef.current && here && cam && !busyRef.current) {
          const near = list.filter(
            (o) =>
              dist(o.centre, here) <= LUMA_RANGE_M &&
              imageFraction(o, here, cam.focal, cam.imageWidth, cam.imageHeight) <= MAX_VOTE_FRACTION
          );
          if (near.length) {
            const frame = frameSamples(cam.transform, cam.focal, cam.imageWidth, cam.imageHeight);
            const pts = [...near.flatMap((o) => lumaSamples(o).flat()), ...frame.flat()];
            const luma = sampleLuma(pts);
            const frameLuma = luma.slice(near.length * 16);
            const byId = new Map(near.map((o, i) => [o.id, voteExterior(o, luma.slice(i * 16, i * 16 + 16), frameLuma)]));
            list = list.map((o) => byId.get(o.id) ?? o);
          }
        }
        putOpenings(list);
      } catch {
        // no mesh yet / module busy: next tick
      } finally {
        running = false;
      }
    };
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [recording, vistaRole]);

  // Vista pass: steer to the nearest unshot target, shoot after a steady hold.
  useEffect(() => {
    if (vistaRole !== 'vista' || !pose || shooting.current) return;
    const T = pose.transform;
    const fwd = fwdOf(T);
    if (targets.current.length === 0) {
      const facing = openingsFacing(openingsRef.current, fwd);
      vistaOpeningIds.current = facing.map((o) => o.id);
      targets.current = visibleTargets(facing, indoorPath.current, outdoorRef.current) ?? makeTargets(fwd);
      done.current = targets.current.map(() => false);
      setVistaTotal(targets.current.length);
    }
    const i = nextTarget(targets.current, done.current, fwd);
    if (i < 0) return;
    const now = Date.now() / 1000;
    const dt = lastPoseT.current ? Math.min(0.3, now - lastPoseT.current) : 0;
    lastPoseT.current = now;
    const aligned = angleDeg(targets.current[i], fwd) <= ALIGN_DEG;
    if (holdStep(hold.current, aligned, pose.trackingNormal, dt)) {
      shooting.current = true;
      captureVistaShot()
        .then((r) => {
          // Weak tracking during the bracket: keep the photos, ask for the point again.
          if (!r.trackingNormal) return;
          done.current[i] = true;
          setVistaDone(done.current.filter(Boolean).length);
        })
        .catch((e) => Alert.alert('Çekilemedi', e?.message ?? String(e)))
        .finally(() => {
          shooting.current = false;
        });
    }
  }, [pose, vistaRole]);

  const openVista = (role: Role) => {
    targets.current = [];
    done.current = [];
    hold.current = { held: 0 };
    lastPoseT.current = 0;
    vistaOpeningIds.current = [];
    setVistaDone(0);
    setVistaTotal(0);
    setAddTaps(null);
    vistaId.current = startVista(role);
    vistaRoleRef.current = role;
    setVistaRole(role);
  };

  const closeVista = async () => {
    const role = vistaRoleRef.current;
    if (!role) return;
    const ids = role === 'vista' ? vistaOpeningIds.current : [];
    try {
      const groups = await endVista(ids);
      if (role === 'vista' && groups > 0 && ids.length) {
        putOpenings(openingsRef.current.map((o) => (ids.includes(o.id) ? { ...o, vista: vistaId.current } : o)));
      }
    } catch (e: any) {
      Alert.alert('Manzara kaydedilemedi', e?.message ?? String(e));
    }
    vistaRoleRef.current = null;
    setVistaRole(null);
  };

  const shootControl = () => {
    if (shooting.current) return;
    shooting.current = true;
    captureVistaShot()
      .then(() => setVistaDone((n) => n + 1))
      .catch((e) => Alert.alert('Çekilemedi', e?.message ?? String(e)))
      .finally(() => {
        shooting.current = false;
      });
  };

  /** Tap on the preview: meter during a vista pass, a corner while adding. */
  const onTap = (x: number, y: number) => {
    if (size.width === 0) return;
    if (vistaRoleRef.current) {
      setWindowExposurePoint(x / size.width, y / size.height);
      return;
    }
    if (!addTaps) return;
    const hit = raycast(x / size.width, y / size.height, size.width, size.height);
    if (!hit) {
      Alert.alert('Nokta bulunamadı', 'Çerçevenin köşesine biraz daha yakından dokun.');
      return;
    }
    const taps = [...addTaps, hit as Vec3];
    if (taps.length < 4) {
      setAddTaps(taps);
      return;
    }
    const list = manualOpening(openingsRef.current, taps, roomCentre());
    if (!list) Alert.alert('Açıklık eklenemedi', 'Dört köşe aynı düzlemde değil. Tekrar dene.');
    else putOpenings(list);
    setAddTaps(null);
  };

  /** Before the recording stops: close an open vista, hand the list to the archive. */
  const prepareStop = async () => {
    if (vistaRoleRef.current) await closeVista();
    try {
      setOpeningsHint(openingsHint(openingsRef.current, floorY.current));
    } catch {
      // the archive is still written without the hint
    }
  };

  const names = openingNames(openings);
  const missing = missingVistas(openings).map((o) => names.get(o.id) ?? o.id);

  const vistaGuide: GuidancePayload | null = (() => {
    if (vistaRole !== 'vista' || !pose || targets.current.length === 0) return null;
    const T = pose.transform;
    const fwd = fwdOf(T);
    const i = nextTarget(targets.current, done.current, fwd);
    if (i < 0) return null;
    return {
      mode: 'explore',
      target: toScreen(targets.current[i], T),
      aligned: angleDeg(targets.current[i], fwd) <= ALIGN_DEG,
      hold: 0,
      progress: vistaTotal ? vistaDone / vistaTotal : 0,
      done: false,
      heightDeviation: 0,
      inBand: true,
      buzzing: false,
      focal: pose.focal,
      imageWidth: pose.imageWidth,
      imageHeight: pose.imageHeight,
    };
  })();

  return {
    reset,
    pose,
    outdoor,
    segmentBusy,
    openings,
    names,
    missing,
    vistaRole,
    vistaDone,
    vistaTotal,
    vistaGuide,
    addTaps,
    toggleOutdoor: () => {
      wantOutdoor.current = !outdoorRef.current;
      return switchSegment(wantOutdoor.current);
    },
    openVista,
    closeVista,
    shootControl,
    startAdd: () => setAddTaps([]),
    cancelAdd: () => setAddTaps(null),
    onTap,
    prepareStop,
    tapsActive: vistaRole !== null || addTaps !== null,
    /** Shared with object mode (walk arrow on the floor, see useObjectMode). */
    floorY: () => floorY.current,
    floorPoints: () => floorPts.current,
    walkedPath: () => indoorPath.current,
  };
}
