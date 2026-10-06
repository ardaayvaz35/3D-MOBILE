// Optional, multi-select labels for the next segment (spec §4.1 step 2).
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LABELS, LABEL_NAMES, type Label } from './houseSession';

export default function LabelPicker({ onDone }: { onDone: (labels: Label[]) => void }) {
  const [picked, setPicked] = useState<Label[]>([]);
  const toggle = (l: Label) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]));
  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>Bu bölümde ne var? (isteğe bağlı)</Text>
      <View style={styles.row}>
        {LABELS.map((l) => (
          <Pressable key={l} style={[styles.chip, picked.includes(l) && styles.chipOn]} onPress={() => toggle(l)}>
            <Text style={styles.chipText}>{LABEL_NAMES[l]}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={styles.go} onPress={() => onDone(picked)}>
        <Text style={styles.goText}>{picked.length ? 'Tamam' : 'Geç'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { margin: 16, padding: 16, borderRadius: 14, gap: 12, backgroundColor: 'rgba(255,255,255,0.95)' },
  title: { fontSize: 16, fontWeight: '700', color: '#111' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: '#e5e5e5' },
  chipOn: { backgroundColor: '#4ade80' },
  chipText: { color: '#111', fontWeight: '600' },
  go: { alignSelf: 'stretch', paddingVertical: 12, borderRadius: 999, backgroundColor: '#111', alignItems: 'center' },
  goText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
