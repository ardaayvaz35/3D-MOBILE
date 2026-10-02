import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RETURN_BAND_M } from '../capture/objectMode';

// Black transition screen (spec 2026-10-02-uygulama-mimarisi.md §3.4, §3.6).
// The camera image is hidden and no frames are kept, but the ARKit session
// keeps tracking underneath (one uninterrupted session, §2). On the way back
// to room mode a bar shows the locked height and where the phone is now.

const BAR_H = 260;
const RANGE_M = 0.6;

type Props = { text: string; heightDev: number; showBar: boolean };

export default function TransitionScreen({ text, heightDev, showBar }: Props) {
  const dev = Math.max(-RANGE_M, Math.min(RANGE_M, heightDev));
  // Phone above the target -> its marker above the line.
  const marker = BAR_H / 2 - (dev / RANGE_M) * (BAR_H / 2);
  const ok = Math.abs(heightDev) <= RETURN_BAND_M;
  return (
    <View style={styles.black} pointerEvents="none">
      <Text style={styles.text}>{text}</Text>
      {showBar ? (
        <View style={styles.bar}>
          <View style={[styles.target, { top: BAR_H / 2 - 2 }]} />
          <View style={[styles.marker, { top: marker - 7, backgroundColor: ok ? '#4ade80' : '#facc15' }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  black: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    padding: 32,
  },
  text: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center', lineHeight: 28 },
  bar: { width: 40, height: BAR_H, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  target: { position: 'absolute', left: -14, right: -14, height: 4, borderRadius: 2, backgroundColor: '#fff' },
  marker: { position: 'absolute', left: 4, width: 32, height: 14, borderRadius: 7 },
});
