import React, { useEffect, useRef, useState } from 'react';
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
import {
  clearPendingUpload,
  loadPendingUpload,
  savePendingUpload,
  type PendingUpload,
} from '../api/pendingUpload';

type Props = NativeStackScreenProps<RootStackParamList, 'LidarScan'>;

const MIN_ANGLE_COVERAGE = 0.5; // ~6/12 sectors -- roughly half-way around

// Native taraftaki JPEG butcesiyle ayni deger (CaptureManager.imageByteBudget).
// R2'de nesne basina pratik bir sinir olmadigi icin bu artik depolama degil,
// yukleme suresi ve telefon isinmasi butcesi. Ikisi birlikte guncellenmeli.
const ARCHIVE_BUDGET_BYTES = 300 * 1024 * 1024;
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export default function LidarScanScreen({ navigation }: Props) {
  const available = isArkitModuleAvailable() && isLidarSupported();
  const [recording, setRecording] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [angleCoverage, setAngleCoverage] = useState(0);
  const [bytesUsed, setBytesUsed] = useState(0);
  const [storageFull, setStorageFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const storageAlerted = useRef(false);

  // A scan that was captured but never reached the server -- including one
  // lost to the app being killed mid-upload -- is offered back on arrival
  // instead of being silently abandoned.
  useEffect(() => {
    loadPendingUpload().then(setPending);
  }, []);

  useEffect(() => {
    const unsubscribe = onFrameCaptured((payload) => {
      setFrameCount(payload.frameCount);
      setAngleCoverage(payload.angleCoverage ?? 0);
      setBytesUsed(payload.bytesUsed ?? 0);
      if (payload.storageLimitReached) setStorageFull(true);
    });
    return unsubscribe;
  }, []);

  // Butce dolunca native taraf yeni kare kaydetmiyor. Kullaniciyi bir kez
  // uyarip taramayi bitirmeye yonlendir, yoksa bosuna gezmeye devam ediyor.
  useEffect(() => {
    if (!storageFull || storageAlerted.current) return;
    storageAlerted.current = true;
    Alert.alert(
      'Kayit sinirina ulasildi',
      'Bu tarama icin ayrilan alan doldu, yeni kareler artik kaydedilmiyor. ' +
        'Taramayi bitirip yukleyebilirsin.',
      [{ text: 'Tamam' }]
    );
  }, [storageFull]);

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
      setBytesUsed(0);
      setStorageFull(false);
      storageAlerted.current = false;
      startLidarRecording();
      setRecording(true);
      return;
    }

    setRecording(false);

    if (angleCoverage < MIN_ANGLE_COVERAGE) {
      Alert.alert(
        'Az açıdan tarandı',
        `Odanın sadece ~${Math.round(angleCoverage * 100)}%'lik bir kısmı tarandı. ` +
          `Daha iyi sonuç için yerinde dönerek en az yarım tur (${Math.round(MIN_ANGLE_COVERAGE * 100)}%+) tara. Yine de yüklemek ister misin?`,
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
      // Record the archive BEFORE uploading. Everything after this point can
      // fail or be killed by the OS, and without this the scan would be
      // unrecoverable -- which is what happened to a 2.6-minute scan that
      // vanished with no error on screen.
      await savePendingUpload({
        archivePath: result.archivePath,
        clientType: 'ios_lidar',
        frameCount: result.frameCount,
      });
      await sendArchive(result.archivePath);
    } catch (err: any) {
      Alert.alert('Hata', err?.message ?? String(err));
      setBusy(false);
    }
  };

  /// Upload an archive that is already on disk, whether it was just captured
  /// or is being retried after a failure.
  const sendArchive = async (archivePath: string) => {
    setBusy(true);
    try {
      const uploadResult = await uploadCapture(
        { uri: `file://${archivePath}`, name: 'scan.zip', mimeType: 'application/zip' },
        'ios_lidar'
      );
      await clearPendingUpload();
      setPending(null);
      navigation.replace('Status', { captureId: uploadResult.capture_id });
    } catch (err: any) {
      // The archive stays on disk and stays recorded, so this is recoverable.
      const stored = await loadPendingUpload();
      setPending(stored);
      Alert.alert(
        'Yükleme başarısız',
        `${err?.message ?? String(err)}\n\nTarama telefonda saklandı, tekrar deneyebilirsin.`
      );
    } finally {
      setBusy(false);
    }
  };

  const coveragePct = Math.round(angleCoverage * 100);
  const coverageOk = angleCoverage >= MIN_ANGLE_COVERAGE;
  const storagePct = Math.min(100, Math.round((bytesUsed / ARCHIVE_BUDGET_BYTES) * 100));
  const storageColor = storageFull ? '#f87171' : storagePct > 75 ? '#eab308' : '#4ade80';

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

            <View style={styles.coverageRow}>
              <View style={styles.coverageTrack}>
                <View
                  style={[
                    styles.coverageFill,
                    { width: `${storagePct}%`, backgroundColor: storageColor },
                  ]}
                />
              </View>
              <Text style={styles.coverageLabel}>{mb(bytesUsed)} MB</Text>
            </View>
          </View>

          {pending && !recording && !busy ? (
            <Pressable style={styles.pendingBanner} onPress={() => sendArchive(pending.archivePath)}>
              <Text style={styles.pendingTitle}>Yüklenmemiş tarama var</Text>
              <Text style={styles.pendingBody}>
                {pending.frameCount} kare, telefonda saklı. Tekrar yüklemek için dokun.
              </Text>
            </Pressable>
          ) : null}

          <View style={styles.bottomBar}>
            <Text style={styles.infoText}>
              {!recording
                ? "Başlat'a bas ve telefonu odada yavaşça gezdir. LiDAR yüzeyleri ölçer, boş ve düz duvarlar da çalışır."
                : storageFull
                  ? 'Kayıt sınırına ulaşıldı. Durdur ve Yükle ile taramayı tamamla.'
                  : coverageOk
                    ? 'İyi gidiyor. Telefonu yavaşça gezdirmeye devam et, köşeleri ve tavanı da tara.'
                    : 'Telefonu yavaşça duvarlara, zemine ve köşelere doğrult. Taranan yüzeyler mavi ağ ile işaretleniyor.'}
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
  pendingBanner: {
    marginHorizontal: 16,
    padding: 14,
    borderRadius: 12,
    gap: 4,
    backgroundColor: 'rgba(234,179,8,0.92)',
  },
  pendingTitle: { color: '#1c1917', fontSize: 15, fontWeight: '700' },
  pendingBody: { color: '#1c1917', fontSize: 13, lineHeight: 18 },
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
