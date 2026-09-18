import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  StatusBar,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  isArkitModuleAvailable,
  isLidarSupported,
  beginWindowScan,
  setWindowExposurePoint,
  captureWindowShot,
  finishWindowScan,
  cancelWindowScan,
  ArkitPreviewView,
} from '../native/arkitCapture';
import { uploadWindowShots } from '../api/captures';

type Props = NativeStackScreenProps<RootStackParamList, 'WindowScan'>;

// Window pass: deliberate single photos of the view through a window, not the
// continuous LiDAR recording. Each press saves three exposures so the server
// can fuse a view that is far brighter than the room. The upload is stored
// only -- no capture row, no credits, no GPU.
const RECOMMENDED_SHOTS = 5;

export default function WindowScanScreen({ navigation }: Props) {
  const available = isArkitModuleAvailable() && isLidarSupported();
  const [shotCount, setShotCount] = useState(0);
  const [busy, setBusy] = useState<null | 'shot' | 'upload'>(null);
  const [meterPoint, setMeterPoint] = useState<{ x: number; y: number } | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const size = useRef({ w: 1, h: 1 });
  const finished = useRef(false);

  useEffect(() => {
    if (!available) return;
    beginWindowScan();
    return () => {
      if (!finished.current) cancelWindowScan();
    };
  }, [available]);

  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };

  const onTapPreview = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    setMeterPoint({ x: locationX, y: locationY });
    setWindowExposurePoint(locationX / size.current.w, locationY / size.current.h);
  };

  const onShoot = async () => {
    setBusy('shot');
    try {
      const r = await captureWindowShot();
      setShotCount(r.shotCount);
    } catch (e: any) {
      Alert.alert('Çekilemedi', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const onFinish = async () => {
    if (shotCount === 0) {
      Alert.alert('Henüz çekim yok', 'Önce en az bir çekim yap.');
      return;
    }
    setBusy('upload');
    try {
      const result = await finishWindowScan();
      finished.current = true;
      const stored = await uploadWindowShots({
        uri: `file://${result.archivePath}`,
        name: 'window.zip',
        mimeType: 'application/zip',
      });
      setUploadedPath(`${stored.backend}: ${stored.storagePath}`);
    } catch (e: any) {
      Alert.alert('Yüklenemedi', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!available) {
    return (
      <View style={styles.center}>
        <Text style={styles.info}>Bu cihazda / build'de ARKit modülü yok.</Text>
      </View>
    );
  }

  if (uploadedPath) {
    return (
      <View style={styles.center}>
        <Text style={styles.doneTitle}>Pencere fotoğrafları yüklendi</Text>
        <Text style={styles.info}>{shotCount} çekim × 3 pozlama</Text>
        <Text selectable style={styles.path}>
          {uploadedPath}
        </Text>
        <Pressable style={styles.secondaryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryText}>Ana ekrana dön</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
        {ArkitPreviewView ? <ArkitPreviewView style={StyleSheet.absoluteFill} /> : null}
        <Pressable style={StyleSheet.absoluteFill} onPress={onTapPreview} disabled={!!busy} />
        {meterPoint && (
          <View
            pointerEvents="none"
            style={[styles.meter, { left: meterPoint.x - 28, top: meterPoint.y - 28 }]}
          />
        )}
      </View>

      <View style={styles.topPanel} pointerEvents="none">
        <Text style={styles.guide}>
          {meterPoint
            ? 'Pencerenin ortasında dur. Sola, ortaya, sağa, biraz yukarı ve aşağı çek; aralarında örtüşme olsun.'
            : 'Önce ekranda dışarıya (manzaraya) dokun: pozlama oraya ayarlansın.'}
        </Text>
        <Text style={styles.counter}>
          {shotCount} / {RECOMMENDED_SHOTS}+ çekim
        </Text>
      </View>

      <View style={styles.bottomPanel}>
        <Pressable
          style={[styles.shootBtn, !!busy && styles.disabled]}
          onPress={onShoot}
          disabled={!!busy}
        >
          {busy === 'shot' ? <ActivityIndicator color="#000" /> : <Text style={styles.shootText}>Çek</Text>}
        </Pressable>
        <Pressable
          style={[styles.finishBtn, (!!busy || shotCount === 0) && styles.disabled]}
          onPress={onFinish}
          disabled={!!busy || shotCount === 0}
        >
          {busy === 'upload' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.finishText}>Bitir ve yükle</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: '#0e0e0e',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  info: { color: '#bbb', fontSize: 15, textAlign: 'center' },
  doneTitle: { color: '#4ade80', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  path: { color: '#fff', fontSize: 12, textAlign: 'center', fontFamily: 'Menlo' },
  meter: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: '#facc15',
  },
  topPanel: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  guide: { color: '#fff', fontSize: 14, lineHeight: 19 },
  counter: { color: '#4ade80', fontSize: 15, fontWeight: '600' },
  bottomPanel: {
    position: 'absolute',
    bottom: 36,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shootBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shootText: { color: '#000', fontSize: 17, fontWeight: '700' },
  finishBtn: {
    backgroundColor: '#16a34a',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    minWidth: 150,
    alignItems: 'center',
  },
  finishText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  secondaryBtn: { marginTop: 12, padding: 12 },
  secondaryText: { color: '#4ade80', fontSize: 15 },
});
