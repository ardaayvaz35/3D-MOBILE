import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getCaptureStatus } from '../api/captures';
import type { CaptureDetail } from '../types/capture';

type Props = NativeStackScreenProps<RootStackParamList, 'Status'>;

const POLL_INTERVAL_MS = 3000;

const STAGE_LABELS: Record<string, string> = {
  uploaded: 'Yüklendi',
  queued: 'Sırada bekliyor',
  sfm_running: 'SfM / nokta bulutu işleniyor',
  training: '3DGS eğitimi sürüyor',
  exporting: 'Splat dışa aktarılıyor',
  done: 'Tamamlandı',
  failed: 'Başarısız',
  unknown: 'Bilinmiyor',
};

export default function StatusScreen({ route, navigation }: Props) {
  const { captureId } = route.params;
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const d = await getCaptureStatus(captureId);
        setDetail(d);
        setError(null);
        if (d.status === 'done' || d.status === 'failed') {
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch (err: any) {
        setError(err?.message ?? String(err));
      }
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [captureId]);

  const progressPct = Math.round((detail?.progress ?? 0) * 100);
  const inProgress =
    !detail || (detail.status !== 'done' && detail.status !== 'failed');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <Text style={styles.captureId}>Capture: {captureId.slice(0, 8)}...</Text>
        <Text style={styles.stage}>{STAGE_LABELS[detail?.status ?? 'unknown']}</Text>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{progressPct}%</Text>

        {detail?.stage_detail ? <Text style={styles.detail}>{detail.stage_detail}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {inProgress && (
          <Text style={styles.reassure}>
            Taraman yüklendi ve işleniyor. İstersen bu ekranı kapatabilirsin — splat
            dosyan hazır olunca “Taramalarım” bölümünde görünecek.
          </Text>
        )}

        {detail?.status === 'done' && (
          <Pressable
            style={styles.button}
            onPress={() => navigation.replace('CaptureDetail', { captureId })}
          >
            <Text style={styles.buttonText}>Sonucu Görüntüle</Text>
          </Pressable>
        )}

        {inProgress && (
          <Pressable
            style={[styles.button, styles.secondaryButton]}
            onPress={() => navigation.replace('MyScans')}
          >
            <Text style={styles.secondaryButtonText}>Taramalarıma Git</Text>
          </Pressable>
        )}

        {detail?.status === 'failed' && (
          <Pressable style={[styles.button, styles.retryButton]} onPress={() => navigation.popToTop()}>
            <Text style={styles.buttonText}>Ana Ekrana Dön</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },
  body: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  captureId: { color: '#666', fontSize: 12 },
  stage: { color: '#fff', fontSize: 20, fontWeight: '700' },
  progressTrack: {
    height: 8,
    backgroundColor: '#2c2c2e',
    borderRadius: 999,
    overflow: 'hidden',
    marginTop: 8,
  },
  progressFill: { height: '100%', backgroundColor: '#4ade80' },
  progressLabel: { color: '#9a9a9e', fontSize: 13 },
  detail: { color: '#9a9a9e', fontSize: 13, marginTop: 4 },
  error: { color: '#f87171', fontSize: 13, marginTop: 4 },
  reassure: { color: '#9a9a9e', fontSize: 13, lineHeight: 19, marginTop: 12 },
  button: {
    backgroundColor: '#4ade80',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 16,
  },
  retryButton: { backgroundColor: '#2c2c2e' },
  secondaryButton: { backgroundColor: '#1c1c1e', borderWidth: 1, borderColor: '#2c2c2e' },
  secondaryButtonText: { color: '#fff', fontWeight: '700' },
  buttonText: { color: '#0e0e0e', fontWeight: '700' },
});
