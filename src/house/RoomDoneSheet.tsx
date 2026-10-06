// After "Odayı bitir" (spec §4.1 step 4): continue the house or finish it.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

type Props = {
  segmentCount: number;
  uploadLine: string;
  newMapNext: boolean;
  onContinue: () => void;
  onFinish: () => void;
  onRetry: (() => void) | null;
};

export default function RoomDoneSheet({ segmentCount, uploadLine, newMapNext, onContinue, onFinish, onRetry }: Props) {
  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>{segmentCount}. bölüm kaydedildi</Text>
      {uploadLine ? <Text style={styles.line}>{uploadLine}</Text> : null}
      <Text style={styles.line}>
        {newMapNext
          ? 'Yeni haritaya geçiliyor. Devam edince önce az önce taradığın yerin en az yarısını yavaşça yeniden tara, sonra yeni bölüme geç.'
          : 'Devam edince önce az önce taradığın yere bak, sonra yeni bölüme dön.'}
      </Text>
      {onRetry ? (
        <Pressable style={styles.alt} onPress={onRetry}>
          <Text style={styles.altText}>Yüklemeyi tekrar dene</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.main} onPress={onContinue}>
        <Text style={styles.mainText}>Evi taramaya devam et</Text>
      </Pressable>
      <Pressable style={styles.alt} onPress={onFinish}>
        <Text style={styles.altText}>Taramayı bitir</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { margin: 16, padding: 16, borderRadius: 14, gap: 10, backgroundColor: 'rgba(255,255,255,0.96)' },
  title: { fontSize: 17, fontWeight: '700', color: '#111' },
  line: { fontSize: 14, color: '#333', lineHeight: 20 },
  main: { paddingVertical: 14, borderRadius: 999, backgroundColor: '#4ade80', alignItems: 'center' },
  mainText: { color: '#0e0e0e', fontWeight: '700', fontSize: 16 },
  alt: { paddingVertical: 12, borderRadius: 999, backgroundColor: '#e5e5e5', alignItems: 'center' },
  altText: { color: '#111', fontWeight: '700', fontSize: 15 },
});
