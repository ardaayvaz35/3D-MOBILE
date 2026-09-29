import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { GuidancePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';

// Guided capture overlay (docs/superpowers/specs/2026-09-30-yonlendirmeli-cekim-design.md):
// a dashed frame where the target is when it is on screen, an arrow at the
// edge when it is not, green when the camera sits on it, and the height bar.
// Haptics are native and for height only.

const BOX = 120;
const BAND_M = 0.07;
const BAR_H = 160;
const BAR_RANGE_M = 0.2;

type Props = { g: GuidancePayload; width: number; height: number };

/** Where the target lands on the aspect-filled portrait preview, or null. */
function project(g: GuidancePayload, width: number, height: number) {
  const t = g.target;
  if (!t || t.forward < 0.3) return null;
  const short = Math.min(g.imageWidth, g.imageHeight);
  const long = Math.max(g.imageWidth, g.imageHeight);
  const scale = Math.max(width / short, height / long);
  const k = g.focal * scale;
  const x = width / 2 + (t.right / t.forward) * k;
  const y = height / 2 - (t.up / t.forward) * k;
  const m = BOX / 2;
  if (x < m || x > width - m || y < m + 100 || y > height - m - 160) return null;
  return { x, y };
}

function turnWord(right: number, up: number) {
  if (Math.abs(right) >= Math.abs(up)) return right > 0 ? 'Sağa dön' : 'Sola dön';
  return up > 0 ? 'Yukarı bak' : 'Aşağı bak';
}

function walkWord(right: number, forward: number) {
  const a = (Math.atan2(right, forward) * 180) / Math.PI;
  if (Math.abs(a) < 45) return 'ileri';
  if (Math.abs(a) > 135) return 'geri';
  return a > 0 ? 'sağa' : 'sola';
}

export function guidanceHint(g: GuidancePayload, width: number, height: number): string {
  if (!g.inBand) return g.heightDeviation > 0 ? 'Telefonu biraz indir' : 'Telefonu biraz kaldır';
  if (g.mode === 'walk' && g.walk) {
    return `Buradan eksik kalmadı: odanın öbür tarafına ${walkWord(g.walk.right, g.walk.forward)} yürü`;
  }
  if (g.mode === 'wait' || !g.target) return 'Yavaşça etrafına bak';
  if (g.aligned) return 'Tut...';
  if (project(g, width, height)) return 'Çerçeveyi ortala';
  return turnWord(g.target.right, g.target.up);
}

export default function GuidanceOverlay({ g, width, height }: Props) {
  const spot = project(g, width, height);
  const t = g.target;

  let arrow: React.ReactNode = null;
  if (t && !spot) {
    // Screen angle toward the target; behind the phone still points the
    // shorter way round.
    const theta = Math.atan2(t.up, t.right);
    const rx = width / 2 - 44;
    const ry = height / 2 - 170;
    const ax = width / 2 + Math.cos(theta) * rx;
    const ay = height / 2 - Math.sin(theta) * ry;
    arrow = (
      <Text
        style={[
          styles.arrow,
          { left: ax - 30, top: ay - 30, transform: [{ rotate: `${(-theta * 180) / Math.PI}deg` }] },
        ]}
      >
        ➜
      </Text>
    );
  }

  const dev = Math.max(-BAR_RANGE_M, Math.min(BAR_RANGE_M, g.heightDeviation));
  // Above the lock -> marker up.
  const markerTop = BAR_H / 2 - (dev / BAR_RANGE_M) * (BAR_H / 2) - 3;
  const bandH = (BAND_M / BAR_RANGE_M) * BAR_H;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {spot ? (
        <View
          style={[
            styles.box,
            { left: spot.x - BOX / 2, top: spot.y - BOX / 2 },
            g.aligned ? styles.boxAligned : null,
          ]}
        >
          {g.aligned ? <View style={[styles.hold, { width: `${Math.round(g.hold * 100)}%` }]} /> : null}
        </View>
      ) : null}
      {/* Centre mark: what "the camera frame" is */}
      {t ? <View style={[styles.centre, { left: width / 2 - 6, top: height / 2 - 6 }]} /> : null}
      {arrow}

      <View style={[styles.bar, { top: height / 2 - BAR_H / 2 }]}>
        <View style={[styles.band, { top: BAR_H / 2 - bandH, height: bandH * 2 }]} />
        <View style={[styles.marker, { top: markerTop, backgroundColor: g.inBand ? '#4ade80' : '#eab308' }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    width: BOX,
    height: BOX,
    borderWidth: 3,
    borderColor: '#4ade80',
    borderStyle: 'dashed',
    borderRadius: 10,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  boxAligned: { borderStyle: 'solid', backgroundColor: 'rgba(74,222,128,0.28)' },
  hold: { height: 6, backgroundColor: '#4ade80' },
  centre: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#fff',
  },
  arrow: {
    position: 'absolute',
    width: 60,
    height: 60,
    fontSize: 48,
    lineHeight: 60,
    textAlign: 'center',
    color: '#4ade80',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  bar: {
    position: 'absolute',
    left: 10,
    width: 14,
    height: BAR_H,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  band: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(74,222,128,0.35)' },
  marker: { position: 'absolute', left: -3, width: 20, height: 6, borderRadius: 3 },
});
