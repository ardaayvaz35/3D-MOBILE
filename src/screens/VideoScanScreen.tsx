import React, { useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { zipFilesWithMetadata } from '../utils/zip';
import { uploadCapture } from '../api/captures';

type Props = NativeStackScreenProps<RootStackParamList, 'VideoScan'>;

const MIN_RECOMMENDED_SECONDS = 10;
const MAX_RECORD_SECONDS = 60;

export default function VideoScanScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAt = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerBody}>
          <Text style={styles.infoText}>Tarama için kamera izni gerekiyor.</Text>
          <Pressable style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>İzin Ver</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const startTimer = () => {
    startedAt.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedSec((Date.now() - startedAt.current) / 1000);
    }, 200);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (recording || busy || !cameraRef.current) return;
    setRecording(true);
    setElapsedSec(0);
    startTimer();
    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_RECORD_SECONDS,
      });
      stopTimer();
      setRecording(false);
      if (video?.uri) {
        await finishAndUpload(video.uri, (Date.now() - startedAt.current) / 1000);
      }
    } catch (err: any) {
      stopTimer();
      setRecording(false);
      Alert.alert('Kayıt hatası', err?.message ?? String(err));
    }
  };

  const stopRecording = () => {
    cameraRef.current?.stopRecording();
  };

  const finishAndUpload = async (videoUri: string, durationSeconds: number) => {
    if (durationSeconds < 3) {
      Alert.alert('Çok kısa', 'Daha iyi bir sonuç için en az birkaç saniye kayıt yap.');
      return;
    }
    setBusy(true);
    try {
      const metadata = {
        client_type: 'web_video',
        video_path: 'scan.mp4',
        metadata: {
          device_model: Device.modelName ?? 'unknown',
          has_lidar: false,
          total_frames: 0,
          duration_seconds: durationSeconds,
        },
      };

      const zipFile = await zipFilesWithMetadata(
        [{ uri: videoUri, name: 'scan.mp4' }],
        metadata,
        `scan_video_${Date.now()}.zip`
      );

      const result = await uploadCapture(
        { uri: zipFile.uri, name: zipFile.name, mimeType: 'application/zip' },
        'web_video'
      );

      navigation.replace('Status', { captureId: result.capture_id });
    } catch (err: any) {
      Alert.alert('Yükleme hatası', err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back" mode="video" mute />

      <View style={styles.overlay}>
        <Text style={styles.counter}>
          {recording ? `● Kayıt: ${elapsedSec.toFixed(1)}s` : 'Kayda hazır'}
        </Text>
        <Text style={styles.hint}>
          Objenin/odanın etrafında yavaşça dön, en az {MIN_RECOMMENDED_SECONDS} saniye kayıt
          öner ilir. Sabit hızda, sarsmadan çek.
        </Text>

        <View style={styles.row}>
          <Pressable
            style={[styles.shutterButton, recording && styles.shutterButtonActive]}
            onPress={recording ? stopRecording : startRecording}
            disabled={busy}
          >
            <Text style={styles.shutterText}>{recording ? 'Durdur' : 'Başlat'}</Text>
          </Pressable>

          {busy && (
            <View style={styles.uploadingRow}>
              <ActivityIndicator color="#4ade80" />
              <Text style={styles.uploadingText}>Yükleniyor...</Text>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  centerBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  infoText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 10,
  },
  counter: { color: '#fff', fontSize: 20, fontWeight: '700' },
  hint: { color: '#ccc', fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  shutterButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterButtonActive: { backgroundColor: '#f87171' },
  shutterText: { color: '#000', fontWeight: '700', fontSize: 12 },
  button: { backgroundColor: '#4ade80', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#0e0e0e', fontWeight: '700' },
  uploadingRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  uploadingText: { color: '#4ade80', fontSize: 13 },
});
