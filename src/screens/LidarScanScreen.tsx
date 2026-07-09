import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, Alert, StatusBar } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  isArkitModuleAvailable,
  isLidarSupported,
  startLidarRecording,
  stopLidarRecording,
  onFrameCaptured,
  ArkitPreviewView,
} from '../native/arkitCapture';
import { uploadCapture } from '../api/captures';

type Props = NativeStackScreenProps<RootStackParamList, 'LidarScan'>;

const MIN_ANGLE_COVERAGE = 0.5; // ~6/12 sectors -- roughly half-way around

export default function LidarScanScreen({ navigation }: Props) {
  const available = isArkitModuleAvailable() && isLidarSupported();
  const [recording, setRecording] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [angleCoverage, setAngleCoverage] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = onFrameCaptured((payload) => {
      setFrameCount(payload.frameCount);
      setAngleCoverage(payload.angleCoverage ?? 0);
    });
    return unsubscribe;
  }, []);

  if (!available) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerBody}>
          <Text style={styles.title}>LiDAR modülü bu build'de yok</Text>
          <Text style={styles.infoText}>
            Bu ekran, ARKit derinlik verisini okuyan özel bir native modüle (Dev Client)
            ihtiyaç duyuyor. Şu an Expo Go üzerinde çalıştığın için bu özellik devre dışı.
            {'\n\n'}
            Dev Client kurulduğunda bu ekran otomatik olarak aktif olacak.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const toggleRecording = async () => {
    if (!recording) {
      setFrameCount(0);
      setAngleCoverage(0);
      startLidarRecording();
      setRecording(true);
      return;
    }

    setRecording(false);

    if (angleCoverage < MIN_ANGLE_COVERAGE) {
      Alert.alert(
        'Az açıdan tarandı',
        `Objenin sadece ~${Math.round(angleCoverage * 100)}%'lik bir açısı tarandı. ` +
          `Daha iyi sonuç için etrafında en az yarım tur (${Math.round(MIN_ANGLE_COVERAGE * 100)}%+) dönerek tekrar tara. Yine de yüklemek ister misin?`,
        [
          { text: 'İptal, devam et', style: 'cancel', onPress: () => setRecording(true) },
          { text: 'Yine de yükle', style: 'destructive', onPress: () => finishAndUpload() },
        ]
      );
      return;
    }

    await finishAndUpload();
  };

  const finishAndUpload = async () => {
    setBusy(true);
    try {
      const result = await stopLidarRecording();
      const uploadResult = await uploadCapture(
        { uri: `file://${result.archivePath}`, name: 'scan.zip', mimeType: 'application/zip' },
        'ios_lidar'
      );
      navigation.replace('Status', { captureId: uploadResult.capture_id });
    } catch (err: any) {
      Alert.alert('Hata', err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const coveragePct = Math.round(angleCoverage * 100);
  const coverageOk = angleCoverage >= MIN_ANGLE_COVERAGE;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.previewWrap}>
        {ArkitPreviewView ? <ArkitPreviewView style={StyleSheet.absoluteFill} /> : null}

        <View style={styles.overlay}>
          <View style={styles.topBar}>
            <Text style={styles.counter}>{frameCount} kare</Text>
            <View style={styles.coverageRow}>
              <View style={styles.coverageTrack}>
                <View
                  style={[
                    styles.coverageFill,
                    { width: `${coveragePct}%`, backgroundColor: coverageOk ? '#4ade80' : '#eab308' },
                  ]}
                />
              </View>
              <Text style={styles.coverageLabel}>{coveragePct}% açı</Text>
            </View>
          </View>

          <View style={styles.bottomBar}>
            <Text style={styles.infoText}>
              {recording
                ? coverageOk
                  ? 'İyi gidiyor — devam et ya da durdur.'
                  : 'Objenin/odanın etrafında yavaşça dön, farklı açılardan çek.'
                : "Başlat'a basıp objenin/odanın etrafında yavaşça dolaş."}
            </Text>

            <Pressable
              style={[styles.recordButton, recording && styles.recordButtonActive]}
              onPress={toggleRecording}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>{recording ? 'Durdur ve Yükle' : 'Başlat'}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  previewWrap: { flex: 1 },
  centerBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, padding: 24 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  infoText: { color: '#fff', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    padding: 16,
    paddingTop: 50,
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  counter: { color: '#fff', fontSize: 18, fontWeight: '700' },
  coverageRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coverageTrack: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 999,
    overflow: 'hidden',
  },
  coverageFill: { height: '100%', borderRadius: 999 },
  coverageLabel: { color: '#fff', fontSize: 12, width: 60, textAlign: 'right' },
  bottomBar: {
    padding: 20,
    paddingBottom: 40,
    alignItems: 'center',
    gap: 16,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  recordButton: {
    backgroundColor: '#4ade80',
    borderRadius: 999,
    paddingVertical: 18,
    paddingHorizontal: 36,
  },
  recordButtonActive: { backgroundColor: '#f87171' },
  buttonText: { color: '#0e0e0e', fontWeight: '700', fontSize: 16 },
});
