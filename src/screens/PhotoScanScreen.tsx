import React, { useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { zipFilesWithMetadata, ZipEntry } from '../utils/zip';
import { uploadCapture } from '../api/captures';

type Props = NativeStackScreenProps<RootStackParamList, 'PhotoScan'>;

type CapturedShot = {
  uri: string;
  width: number;
  height: number;
  timestampNs: number;
};

const MIN_RECOMMENDED_SHOTS = 40;

export default function PhotoScanScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [shots, setShots] = useState<CapturedShot[]>([]);
  const [busy, setBusy] = useState(false);
  const startedAt = useRef<number>(Date.now());

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

  const takeShot = async () => {
    if (busy) return;
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.85, skipProcessing: true });
    if (!photo) return;
    setShots((prev) => [
      ...prev,
      {
        uri: photo.uri,
        width: photo.width,
        height: photo.height,
        timestampNs: Date.now() * 1_000_000,
      },
    ]);
  };

  const finishAndUpload = async () => {
    if (shots.length < 10) {
      Alert.alert('Yetersiz kare', 'Daha iyi bir sonuç için en az 10, tercihen 40+ foto çek.');
      return;
    }
    setBusy(true);
    try {
      const entries: ZipEntry[] = shots.map((s, i) => ({
        uri: s.uri,
        name: `frame_${String(i).padStart(6, '0')}.jpg`,
      }));

      const metadata = {
        client_type: 'web_photo',
        frames: shots.map((s, i) => ({
          frame_id: i,
          timestamp_ns: s.timestampNs,
          image_path: `frame_${String(i).padStart(6, '0')}.jpg`,
          image_width: s.width,
          image_height: s.height,
        })),
        metadata: {
          device_model: Device.modelName ?? 'unknown',
          has_lidar: false,
          total_frames: shots.length,
          duration_seconds: (Date.now() - startedAt.current) / 1000,
        },
      };

      const zipFile = await zipFilesWithMetadata(entries, metadata, `scan_${Date.now()}.zip`);

      const result = await uploadCapture(
        { uri: zipFile.uri, name: zipFile.name, mimeType: 'application/zip' },
        'web_photo'
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
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />

      <View style={styles.overlay}>
        <Text style={styles.counter}>{shots.length} kare</Text>
        <Text style={styles.hint}>
          Objenin etrafında yavaşça dön, {MIN_RECOMMENDED_SHOTS}+ kare öner ilir. Her açıdan,
          %60-80 örtüşme ile çek.
        </Text>

        <View style={styles.row}>
          <Pressable style={[styles.shutterButton]} onPress={takeShot} disabled={busy}>
            <Text style={styles.shutterText}>Çek</Text>
          </Pressable>

          <Pressable
            style={[styles.button, styles.finishButton]}
            onPress={finishAndUpload}
            disabled={busy || shots.length === 0}
          >
            {busy ? (
              <ActivityIndicator color="#0e0e0e" />
            ) : (
              <Text style={styles.buttonText}>Bitir ve Yükle</Text>
            )}
          </Pressable>
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
  shutterText: { color: '#000', fontWeight: '700' },
  button: { backgroundColor: '#4ade80', borderRadius: 10, padding: 14, alignItems: 'center' },
  finishButton: { flex: 1 },
  buttonText: { color: '#0e0e0e', fontWeight: '700' },
});
