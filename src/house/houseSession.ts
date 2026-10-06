// House session state machine (spec 2026-10-05-ev-olcegi-design.md §4, §8.2).
// Pure: no React Native, no I/O -- the hook (useHouseCapture) feeds it events
// and persists what it returns. A "segment" is whatever the agent scanned
// before pressing "Odayı bitir"; it has no architectural meaning.

export const LABELS = ['salon', 'yatak', 'mutfak', 'banyo', 'koridor', 'merdiven', 'balkon', 'diger'] as const;
export type Label = (typeof LABELS)[number];
export const LABEL_NAMES: Record<Label, string> = {
  salon: 'Salon', yatak: 'Yatak odası', mutfak: 'Mutfak', banyo: 'Banyo',
  koridor: 'Koridor', merdiven: 'Merdiven', balkon: 'Balkon', diger: 'Diğer',
};

export type MultipartState = {
  storagePath: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  size: number;
  etags: Record<number, string>;
  /** ms epoch of init; missing in states saved by older builds (treated as stale). */
  startedAt?: number;
};

export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';

export type Segment = {
  index: number;
  labels: Label[];
  archivePath: string;
  frameCount: number;
  mapId: string;
  /// Same coordinate frame as the earlier segments of this map.
  relocalized: boolean;
  floorHeightM: number | null;
  upload: UploadState;
  /// The archive is complete in R2 (multipart completed); only submit-capture is left.
  stored: boolean;
  multipart?: MultipartState;
  captureId?: string;
  error?: string;
};

export type Phase = 'pickLabels' | 'resuming' | 'ready' | 'recording' | 'roomDone' | 'finishing' | 'finished';

export type House = {
  propertyId: string;
  name: string;
  createdAt: string;
  phase: Phase;
  mapId: string;
  mapBytes: number;
  mapFloorY: number | null;
  pendingLabels: Label[];
  relocalized: boolean;
  resumeStartedAt: number | null;
  segments: Segment[];
};

export type HouseEvent =
  | { type: 'labelsPicked'; labels: Label[] }
  | { type: 'recordingStarted' }
  | { type: 'segmentSaved'; archivePath: string; frameCount: number; floorHeightM: number | null; mapBytes: number }
  | { type: 'continue' }
  | { type: 'finish' }
  | { type: 'appReopened'; nowMs: number }
  | { type: 'relocalized' }
  | { type: 'newMapStarted'; mapId: string }
  | { type: 'uploadStarted'; index: number }
  | { type: 'uploadProgress'; index: number; multipart: MultipartState }
  | { type: 'stored'; index: number }
  | { type: 'uploaded'; index: number; captureId: string }
  | { type: 'uploadFailed'; index: number; error: string }
  | { type: 'retryUploads' }
  | { type: 'finished' };

/// ARKit forgets old areas of a big map (RoomPlan stops near ~58 MB); keep under.
export const NEW_MAP_BYTES = 40 * 1024 * 1024;
/// Same threshold the viewer uses to call a new floor.
export const NEW_FLOOR_M = 1.8;
export const RELOC_HINT_MS = 60_000;
export const RELOC_NEW_MAP_MS = 120_000;

export function newHouse(propertyId: string, name: string, now: Date, mapId: string): House {
  return {
    propertyId, name, createdAt: now.toISOString(), phase: 'pickLabels', mapId,
    mapBytes: 0, mapFloorY: null, pendingLabels: [], relocalized: true, resumeStartedAt: null, segments: [],
  };
}

function patchSegment(h: House, index: number, patch: Partial<Segment>): House {
  if (!h.segments.some((s) => s.index === index)) return h;
  return { ...h, segments: h.segments.map((s) => (s.index === index ? { ...s, ...patch } : s)) };
}

export function reduce(h: House, e: HouseEvent): House {
  switch (e.type) {
    case 'labelsPicked':
      return h.phase === 'pickLabels' ? { ...h, phase: 'ready', pendingLabels: [...e.labels] } : h;
    case 'recordingStarted':
      return h.phase === 'ready' ? { ...h, phase: 'recording' } : h;
    case 'segmentSaved': {
      if (h.phase !== 'recording') return h;
      const seg: Segment = {
        index: h.segments.length, labels: h.pendingLabels, archivePath: e.archivePath, frameCount: e.frameCount,
        mapId: h.mapId, relocalized: h.relocalized, floorHeightM: e.floorHeightM, upload: 'pending', stored: false,
      };
      return {
        ...h, phase: 'roomDone', segments: [...h.segments, seg], mapBytes: e.mapBytes,
        mapFloorY: h.mapFloorY ?? e.floorHeightM, pendingLabels: [],
      };
    }
    case 'continue':
      return h.phase === 'roomDone' ? { ...h, phase: 'pickLabels', relocalized: true } : h;
    case 'finish':
      return h.phase === 'roomDone' ? { ...h, phase: 'finishing' } : h;
    case 'appReopened':
      return ['pickLabels', 'ready', 'recording', 'roomDone'].includes(h.phase)
        ? { ...h, phase: 'resuming', resumeStartedAt: e.nowMs, relocalized: false }
        : h;
    case 'relocalized':
      return h.phase === 'resuming' ? { ...h, phase: 'pickLabels', relocalized: true, resumeStartedAt: null } : h;
    case 'newMapStarted':
      return h.phase === 'resuming' || h.phase === 'pickLabels'
        ? { ...h, phase: 'pickLabels', mapId: e.mapId, mapBytes: 0, mapFloorY: null, relocalized: false, resumeStartedAt: null }
        : h;
    case 'uploadStarted':
      return patchSegment(h, e.index, { upload: 'uploading', error: undefined });
    case 'uploadProgress':
      return patchSegment(h, e.index, { multipart: e.multipart });
    case 'stored':
      return patchSegment(h, e.index, { stored: true });
    case 'uploaded':
      return patchSegment(h, e.index, { upload: 'uploaded', captureId: e.captureId, error: undefined });
    case 'uploadFailed':
      return patchSegment(h, e.index, { upload: 'failed', error: e.error });
    case 'retryUploads':
      return h.segments.some((s) => s.upload === 'failed')
        ? { ...h, segments: h.segments.map((s) => (s.upload === 'failed' ? { ...s, upload: 'pending' } : s)) }
        : h;
    case 'finished':
      return h.phase === 'finishing' ? { ...h, phase: 'finished' } : h;
  }
}

export function canRecord(h: House): boolean {
  return h.phase === 'ready';
}

/// One upload at a time, in order. Failed segments wait for retryUploads.
export function nextUpload(h: House): Segment | null {
  if (h.segments.some((s) => s.upload === 'uploading')) return null;
  return h.segments.find((s) => s.upload === 'pending') ?? null;
}

export function allUploaded(h: House): boolean {
  return h.segments.length > 0 && h.segments.every((s) => s.upload === 'uploaded');
}

/// Called after a segment is saved: should the next one start a fresh map?
export function needsNewMap(h: House): boolean {
  if (h.mapBytes > NEW_MAP_BYTES) return true;
  const last = h.segments[h.segments.length - 1];
  if (!last || last.floorHeightM === null || h.mapFloorY === null) return false;
  return Math.abs(last.floorHeightM - h.mapFloorY) >= NEW_FLOOR_M;
}

export function relocalizeHint(h: House, nowMs: number): 'none' | 'hint' | 'offerNewMap' {
  if (h.phase !== 'resuming' || h.resumeStartedAt === null) return 'none';
  const t = nowMs - h.resumeStartedAt;
  if (t >= RELOC_NEW_MAP_MS) return 'offerNewMap';
  if (t >= RELOC_HINT_MS) return 'hint';
  return 'none';
}

export function segmentFields(h: House, s: Segment) {
  return {
    property_id: h.propertyId,
    segment_index: s.index,
    labels: s.labels,
    floor_height_m: s.floorHeightM,
    map_id: s.mapId,
  };
}
