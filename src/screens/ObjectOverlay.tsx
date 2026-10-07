import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PosePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';
import { toScreen } from '../capture/vistaTargets';
import { BOX_EDGES, boxCorners, type Slice, type Vec3 } from '../capture/objectMode';
import { resample } from '../capture/walkPath';
import type { ObjectModeView } from '../capture/useObjectMode';

// Object mode drawing (spec 2026-10-02-uygulama-mimarisi.md §3.2-3.5):
// thin 3D box lines with each piece's name, the walk arrow lying on the floor,
// and the dome's fill as a small ring. No SVG in this app: lines are rotated
// Views, the floor arrow is a row of chevrons along the route.

type Props = { pose: PosePayload; om: ObjectModeView; floorY: number | null; width: number; height: number };

type P2 = { x: number; y: number; depth: number };

/** World point to preview pixels, same framing as GuidanceOverlay. Null behind the camera. */
export function projectPoint(p: Vec3, pose: PosePayload, width: number, height: number): P2 | null {
  const T = pose.transform;
  const s = toScreen([p[0] - T[12], p[1] - T[13], p[2] - T[14]], T);
  if (s.forward < 0.2) return null;
  const short = Math.min(pose.imageWidth, pose.imageHeight);
  const long = Math.max(pose.imageWidth, pose.imageHeight);
  const k = pose.focal * Math.max(width / short, height / long);
  return { x: width / 2 + (s.right / s.forward) * k, y: height / 2 - (s.up / s.forward) * k, depth: s.forward };
}

function Line({ a, b, color, w }: { a: P2; b: P2; color: string; w: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  return (
    <View
      style={{
        position: 'absolute',
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - w / 2,
        width: len,
        height: w,
        backgroundColor: color,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

/** Chevrons along the first 2.5 m of the route, flat on the floor, pointing along it. */
function FloorArrow({ route, pose, floorY, width, height }: {
  route: Vec3[]; pose: PosePayload; floorY: number; width: number; height: number;
}) {
  const pts = resample(route, 0.35, 2.5).map((p): Vec3 => [p[0], floorY + 0.01, p[2]]);
  const out: React.ReactNode[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = projectPoint(pts[i - 1], pose, width, height);
    const b = projectPoint(pts[i], pose, width, height);
    if (!a || !b) continue;
    const size = Math.max(18, Math.min(70, 90 / b.depth));
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    out.push(
      <Text
        key={i}
        style={[
          styles.chevron,
          {
            left: b.x - size / 2,
            top: b.y - size / 2,
            width: size,
            height: size,
            fontSize: size * 0.8,
            lineHeight: size,
            opacity: 1 - i / (pts.length + 1),
            transform: [{ rotate: `${ang}rad` }, { scaleY: 0.55 }],
          },
        ]}
      >
        ➤
      </Text>
    );
  }
  return <>{out}</>;
}

/** 3 rings x 12 dots, top-down, filled green. */
function DomeRing({ dome, progress }: { dome: Slice[]; progress: number }) {
  const R = [20, 34, 48];
  return (
    <View style={styles.ring}>
      {dome.map((s, i) => {
        // A spot nobody can stand at (wall, other furniture) is not a target.
        if (!s.reachable && !s.filled) return null;
        const r = R[2 - s.ring]; // near ring (steep) inside
        const a = (s.azimuth * Math.PI) / 180;
        return (
          <View
            key={i}
            style={[
              styles.ringDot,
              { left: 56 + Math.sin(a) * r - 5, top: 56 - Math.cos(a) * r - 5 },
              s.filled ? styles.ringDotOn : null,
            ]}
          />
        );
      })}
      <Text style={styles.ringText}>%{Math.round(progress * 100)}</Text>
    </View>
  );
}

export default function ObjectOverlay({ pose, om, floorY, width, height }: Props) {
  const inObject = om.state.kind === 'object';
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {om.objects.map(({ o, name, done }) => {
        // A finished piece shows nothing: no box, no name (its mesh turns green natively).
        if (done) return null;
        if (inObject && om.current && o.id !== om.current.id) return null;
        const color = om.current?.id === o.id ? '#ffffff' : '#facc15';
        const c = boxCorners(o).map((p) => projectPoint(p, pose, width, height));
        const top = projectPoint([o.center[0], o.center[1] + o.size[1] / 2 + 0.08, o.center[2]], pose, width, height);
        return (
          <React.Fragment key={o.id}>
            {BOX_EDGES.map(([i, j], k) => {
              const a = c[i];
              const b = c[j];
              return a && b ? <Line key={k} a={a} b={b} color={color} w={2} /> : null;
            })}
            {top ? (
              <View style={[styles.tag, { left: top.x - 60, top: top.y - 14, borderColor: color }]}>
                <Text style={styles.tagText} numberOfLines={1}>
                  {name}
                </Text>
              </View>
            ) : null}
          </React.Fragment>
        );
      })}
      {om.route && floorY !== null ? (
        <FloorArrow route={om.route} pose={pose} floorY={floorY} width={width} height={height} />
      ) : null}
      {inObject ? <DomeRing dome={om.dome} progress={om.progress} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    position: 'absolute',
    width: 120,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
  },
  tagText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  chevron: {
    position: 'absolute',
    textAlign: 'center',
    color: '#38bdf8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
  ring: {
    position: 'absolute',
    right: 12,
    top: 150,
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  ringDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  ringDotOn: { backgroundColor: '#4ade80' },
  ringText: { position: 'absolute', left: 0, right: 0, top: 46, textAlign: 'center', color: '#fff', fontWeight: '700' },
});
