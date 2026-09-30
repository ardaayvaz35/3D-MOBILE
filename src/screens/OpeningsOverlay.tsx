import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PosePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';
import { toScreen, type Vec3 } from '../capture/vistaTargets';
import { isExterior, type Opening } from '../capture/openings';

type Props = {
  pose: PosePayload;
  openings: Opening[];
  names: Map<string, string>;
  taps: Vec3[] | null;
  width: number;
  height: number;
};

const DOT = 10;

/** World point to preview pixels, same framing as GuidanceOverlay. Null behind the camera. */
function projectPoint(p: Vec3, pose: PosePayload, width: number, height: number) {
  const T = pose.transform;
  const s = toScreen([p[0] - T[12], p[1] - T[13], p[2] - T[14]], T);
  if (s.forward < 0.2) return null;
  const short = Math.min(pose.imageWidth, pose.imageHeight);
  const long = Math.max(pose.imageWidth, pose.imageHeight);
  const k = pose.focal * Math.max(width / short, height / long);
  return { x: width / 2 + (s.right / s.forward) * k, y: height / 2 - (s.up / s.forward) * k };
}

function statusWord(o: Opening) {
  if (o.seen === 0) return 'bakılıyor';
  if (!isExterior(o)) return 'iç';
  return o.vista ? 'manzara tamam' : 'manzara gerekli';
}

/** Corner dots and a name tag for every live opening; tapped corners while adding one. */
export default function OpeningsOverlay({ pose, openings, names, taps, width, height }: Props) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {openings.map((o) => {
        const color = !isExterior(o) ? '#cbd5e1' : o.vista ? '#4ade80' : '#facc15';
        const corners = o.corners.map((c) => projectPoint(c, pose, width, height));
        const centre = projectPoint(o.centre, pose, width, height);
        return (
          <React.Fragment key={o.id}>
            {corners.map((c, i) =>
              c ? (
                <View
                  key={i}
                  style={[styles.dot, { left: c.x - DOT / 2, top: c.y - DOT / 2, backgroundColor: color }]}
                />
              ) : null
            )}
            {centre ? (
              <View style={[styles.tag, { left: centre.x - 70, top: centre.y - 14, borderColor: color }]}>
                <Text style={styles.tagText} numberOfLines={1}>
                  {names.get(o.id)} · {statusWord(o)}
                </Text>
              </View>
            ) : null}
          </React.Fragment>
        );
      })}
      {(taps ?? []).map((t, i) => {
        const c = projectPoint(t, pose, width, height);
        return c ? <View key={`t${i}`} style={[styles.dot, styles.tap, { left: c.x - 7, top: c.y - 7 }]} /> : null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2 },
  tap: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#38bdf8' },
  tag: {
    position: 'absolute',
    width: 140,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
  },
  tagText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
