// Binds the pure house state machine to the phone: native world map, the
// upload queue, and persistence after every change (spec 2026-10-05 §4).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  currentTrackingState, onTrackingStateChanged, resumeFromWorldMap, saveWorldMap, setHouseInfo, startNewMap,
} from '../native/arkitCapture';
import type { TrackingStatePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';
import { submitCapture } from '../api/captures';
import { uploadMultipart } from '../api/multipartUpload';
import { finishProperty } from '../api/houses';
import {
  allUploaded, needsNewMap, nextUpload, reduce, relocalizeHint, segmentFields,
  type House, type HouseEvent, type Label,
} from './houseSession';
import { loadHouse, newMapId, saveHouse, worldMapPath } from './houseStore';

export function useHouseCapture(propertyId: string | undefined, resume: boolean) {
  const [house, setHouse] = useState<House | null>(null);
  const [tracking, setTracking] = useState<TrackingStatePayload>({ state: 'notAvailable', reason: '' });
  const [now, setNow] = useState(Date.now());
  // Bumped when an upload ends, so the queue effect runs again for the next segment.
  const [tick, setTick] = useState(0);
  const ref = useRef<House | null>(null);
  const uploading = useRef(false);
  const sawRelocalizing = useRef(false);

  const dispatch = useCallback((e: HouseEvent) => {
    const cur = ref.current;
    if (!cur) return;
    const next = reduce(cur, e);
    if (next === cur) return;
    ref.current = next;
    setHouse(next);
    saveHouse(next).catch((err) => console.log('[house] save failed', err));
  }, []);

  // Load; when reopening after the app was closed, run the session on the saved map.
  useEffect(() => {
    if (!propertyId) return;
    let alive = true;
    (async () => {
      const h = await loadHouse(propertyId);
      if (!alive || !h) return;
      ref.current = h;
      setHouse(h);
      if (resume && h.segments.length > 0 && h.phase !== 'finishing' && h.phase !== 'finished') {
        sawRelocalizing.current = false;
        dispatch({ type: 'appReopened', nowMs: Date.now() });
        try {
          await resumeFromWorldMap(worldMapPath(h.propertyId, h.mapId));
        } catch (err) {
          console.log('[house] world map unreadable, offering a new map', err);
        }
      }
    })();
    return () => { alive = false; };
  }, [propertyId, resume, dispatch]);

  // Relocalized = the first `normal` after `relocalizing` (spec §4.2).
  useEffect(() => {
    if (!propertyId) return;
    setTracking(currentTrackingState());
    return onTrackingStateChanged((t) => {
      setTracking(t);
      if (t.reason === 'relocalizing') sawRelocalizing.current = true;
      if (t.state === 'normal' && sawRelocalizing.current && ref.current?.phase === 'resuming') {
        dispatch({ type: 'relocalized' });
      }
    });
  }, [propertyId, dispatch]);

  // Clock for the 60 s / 120 s hints while resuming.
  useEffect(() => {
    if (house?.phase !== 'resuming') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [house?.phase]);

  // Upload queue: one segment at a time, resumable, never re-uploading a stored archive.
  useEffect(() => {
    const h = house;
    if (!h || uploading.current) return;
    const seg = nextUpload(h);
    if (!seg) return;
    uploading.current = true;
    dispatch({ type: 'uploadStarted', index: seg.index });
    (async () => {
      try {
        let storagePath = seg.multipart?.storagePath;
        if (!seg.stored) {
          const done = await uploadMultipart(`file://${seg.archivePath}`, seg.multipart, async (mp) => {
            dispatch({ type: 'uploadProgress', index: seg.index, multipart: mp });
          });
          storagePath = done.storagePath;
          dispatch({ type: 'stored', index: seg.index });
        }
        const r = await submitCapture(storagePath!, 'ios_lidar', segmentFields(h, seg));
        dispatch({ type: 'uploaded', index: seg.index, captureId: r.capture_id });
      } catch (err: any) {
        dispatch({ type: 'uploadFailed', index: seg.index, error: err?.message ?? String(err) });
      } finally {
        uploading.current = false;
        setTick((t) => t + 1);
      }
    })();
  }, [house, tick, dispatch]);

  // Finishing: once every segment is in, tell the server.
  useEffect(() => {
    const h = house;
    if (!h || h.phase !== 'finishing' || !allUploaded(h)) return;
    finishProperty(h.propertyId)
      .then(() => dispatch({ type: 'finished' }))
      .catch((err) => console.log('[house] finish failed, will retry on next change', err));
  }, [house, dispatch]);

  const pickLabels = (labels: Label[]) => dispatch({ type: 'labelsPicked', labels });

  const recordingStarted = () => {
    const h = ref.current;
    if (!h) return;
    dispatch({ type: 'recordingStarted' });
    setHouseInfo({
      property_id: h.propertyId,
      segment_index: h.segments.length,
      labels: h.pendingLabels,
      map_id: h.mapId,
      relocalized: h.relocalized,
    });
  };

  const segmentFinished = async (archivePath: string, frameCount: number, floorHeightM: number | null) => {
    const h = ref.current;
    if (!h) return;
    let mapBytes = h.mapBytes;
    try {
      const r = await saveWorldMap(worldMapPath(h.propertyId, h.mapId));
      mapBytes = r.bytes;
      if (r.mappingStatus !== 'mapped' && r.mappingStatus !== 'extending') {
        console.log('[house] world map saved while', r.mappingStatus);
      }
    } catch (err) {
      console.log('[house] world map not saved', err);
    }
    dispatch({ type: 'segmentSaved', archivePath, frameCount, floorHeightM, mapBytes });
  };

  const continueHouse = () => {
    dispatch({ type: 'continue' });
    const h = ref.current;
    if (h && needsNewMap(h)) {
      startNewMap();
      dispatch({ type: 'newMapStarted', mapId: newMapId() });
    }
  };

  const startNewMapNow = () => {
    startNewMap();
    dispatch({ type: 'newMapStarted', mapId: newMapId() });
  };

  const done = house?.segments.filter((s) => s.upload === 'uploaded').length ?? 0;
  const total = house?.segments.length ?? 0;
  const failed = house?.segments.find((s) => s.upload === 'failed');
  const uploadLine = failed
    ? `Yükleme durdu: ${failed.error}`
    : total === 0 ? '' : done === total ? `${total} bölüm yüklendi ✓` : `Yükleniyor: ${done}/${total} bölüm`;

  return {
    house,
    hint: house ? relocalizeHint(house, now) : ('none' as const),
    tracking,
    pickLabels,
    recordingStarted,
    segmentFinished,
    continueHouse,
    finishHouse: () => dispatch({ type: 'finish' }),
    startNewMapNow,
    retryUploads: () => dispatch({ type: 'retryUploads' }),
    uploadLine,
  };
}
