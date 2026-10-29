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
  onGuidance,
  getVideoFormats,
  ArkitPreviewView,
} from '../native/arkitCapture';
import type { GuidancePayload } from '../../modules/arkit-capture/src/ArkitCapture.types';
import GuidanceOverlay, { guidanceHint } from './GuidanceOverlay';
import OpeningsOverlay from './OpeningsOverlay';
import ObjectOverlay from './ObjectOverlay';
import TransitionScreen from './TransitionScreen';
import { useVistaCapture } from '../capture/useVistaCapture';
import { FINISH_OFFER, useObjectMode } from '../capture/useObjectMode';
import { angleDeg, AIM_DEG } from '../capture/objectMode';
import { toScreen } from '../capture/vistaTargets';
import { uploadCapture } from '../api/captures';
import {
  clearPendingUpload,
  loadPendingUpload,
  savePendingUpload,
  type PendingUpload,
} from '../api/pendingUpload';
import { useHouseCapture } from '../house/useHouseCapture';
import { needsNewMap } from '../house/houseSession';
import LabelPicker from '../house/LabelPicker';
import RoomDoneSheet from '../house/RoomDoneSheet';
import ResumeRelocalizeOverlay from '../house/ResumeRelocalizeOverlay';

type Props = NativeStackScreenProps<RootStackParamList, 'LidarScan'>;

const MIN_ANGLE_COVERAGE = 0.5; // ~6/12 sectors -- roughly half-way around

// Native taraftaki JPEG butcesiyle ayni deger (CaptureManager.imageByteBudget).
// R2'de nesne basina pratik bir sinir olmadigi icin bu artik depolama degil,
// yukleme suresi ve telefon isinmasi butcesi. Ikisi birlikte guncellenmeli.
const ARCHIVE_BUDGET_BYTES = 300 * 1024 * 1024;
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export default function LidarScanScreen({ navigation, route }: Props) {
  const available = isArkitModuleAvailable() && isLidarSupported();
  // House session (spec 2026-10-05 §4): absent = the single-room scan, unchanged.
  const houseParam = route.params?.house;
  const hc = useHouseCapture(houseParam?.propertyId, houseParam?.resume ?? false);
  const inHouse = !!houseParam && !!hc.house;
  const [recording, setRecording] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [angleCoverage, setAngleCoverage] = useState(0);
  const [bytesUsed, setBytesUsed] = useState(0);
  const [storageFull, setStorageFull] = useState(false);
  const [tooFast, setTooFast] = useState(false);
  // iOS thermal state: 0 nominal, 1 fair, 2 serious, 3 critical.
  const [thermalState, setThermalState] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const storageAlerted = useRef(false);
  const heatAlerted = useRef(false);
  const [guide, setGuide] = useState<GuidancePayload | null>(null);
  const [doneDismissed, setDoneDismissed] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [formatLine, setFormatLine] = useState('');
  const wrapRef = useRef<View>(null);
  const wrapOffset = useRef({ x: 0, y: 0 });
  // Openings, outdoor segment and vista pass (spec 2026-09-30-pencere-manzara-design.md §4).
  const v = useVistaCapture(recording, size);
  // Object mode: RoomPlan's furniture, walk-arounds, black screens (spec 2026-10-02 §3.3-3.6).
  const om = useObjectMode(recording, guide, frameCount, v);

  // 0.5x measurement: which cameras ARKit world tracking can run on here.
  useEffect(() => {
    const formats = getVideoFormats();
    console.log('[capture] ARKit video formats', JSON.stringify(formats));
    if (!formats.length) return;
    const devices = Array.from(new Set(formats.map((f) => (f.device ?? '?').replace('AVCaptureDeviceTypeBuiltIn', ''))));
    const ultra = formats.some((f) => (f.device ?? '').includes('UltraWide'));
    setFormatLine(`ARKit 0.5x: ${ultra ? 'VAR' : 'YOK'} · ${formats.length} format · ${devices.join(', ')}`);
  }, []);

  useEffect(() => onGuidance(setGuide), []);

  useEffect(() => {
    if (hc.house?.phase === 'finished') navigation.replace('MyScans');
  }, [hc.house?.phase, navigation]);

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
      setTooFast(!!payload.movingTooFast);
      setThermalState(payload.thermalState ?? 0);
    });
    return unsubscribe;
  }, []);

  // At critical the native side has stopped taking frames. Say so once, so the
  // user finishes instead of walking on with a phone that is only getting hotter.
  useEffect(() => {
    if (thermalState < 3 || heatAlerted.current) return;
    heatAlerted.current = true;
    Alert.alert(
      'Telefon çok ısındı',
      'Telefonu korumak için yeni kare kaydı durduruldu. Taramayı bitirip yükle; ' +
        'kalan yerleri telefon soğuduktan sonra ayrı bir taramada çekebilirsin.',
      [{ text: 'Tamam' }]
    );
  }, [thermalState]);

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
    // A house segment starts only after its labels are picked (and, when resuming, the map is found).
    if (inHouse && !recording && hc.house?.phase !== 'ready') return;
    if (!recording) {
      setFrameCount(0);
      setAngleCoverage(0);
      setBytesUsed(0);
      setStorageFull(false);
      storageAlerted.current = false;
      setGuide(null);
      setDoneDismissed(false);
      v.reset();
      om.reset();
      try {
        console.log('[DEBUG-start] startLidarRecording');
        startLidarRecording();
        // After start: setHouseInfo needs the running CaptureManager.
        if (inHouse) hc.recordingStarted();
      } catch (err: any) {
        // A start that throws used to leave the button looking dead.
        console.log('[DEBUG-start] failed', err?.message ?? String(err));
        Alert.alert('Tarama başlatılamadı', err?.message ?? String(err));
        return;
      }
      setRecording(true);
      return;
    }

    // Spec §3.3: the tour does not end before every main piece is walked around.
    if (om.pendingNames.length > 0 && om.state.kind === 'room') {
      Alert.alert(
        'Eşya taraması eksik',
        `${om.pendingNames.join(', ')} henüz her açıdan çekilmedi. Ok seni yanına götürür. Yine de bitirmek ister misin?`,
        [
          { text: 'Geri dön', style: 'cancel' },
          { text: 'Yine de bitir', style: 'destructive', onPress: () => stopNow() },
        ]
      );
      return;
    }
    await stopNow();
  };

  const stopNow = async () => {
    setRecording(false);
    setGuide(null);

    // Every opening that looks out needs its vista; say which ones are missing.
    if (v.missing.length > 0) {
      Alert.alert(
        'Manzara eksik',
        `${v.missing.join(', ')} için manzara çekilmedi. Camın ya da balkonun önünde "Manzara çek"e bas. Yine de bitirmek ister misin?`,
        [
          { text: 'Geri dön', style: 'cancel', onPress: () => setRecording(true) },
          { text: 'Yine de bitir', style: 'destructive', onPress: () => checkCoverageAndFinish() },
        ]
      );
      return;
    }
    await checkCoverageAndFinish();
  };

  const checkCoverageAndFinish = async () => {
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
      await v.prepareStop();
      const result = await stopLidarRecording();
      if (inHouse) {
        // The house record is persistent and its queue uploads the segment;
        // the session keeps running so the next segment shares coordinates.
        await hc.segmentFinished(result.archivePath, result.frameCount, v.floorY());
        setBusy(false);
        return;
      }
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
  const guiding = recording && guide !== null;
  const progressPct = guide ? Math.round(guide.progress * 100) : 0;
  const showDone = guiding && !!guide?.done && !doneDismissed && om.pendingNames.length === 0 && om.state.kind === 'room';
  const inObject = om.state.kind === 'object';
  // Object mode: the camera arrow aims at the piece; no height bar (height is free).
  const objectGuide: GuidancePayload | null =
    inObject && om.aim && v.pose
      ? (() => {
          const T = v.pose.transform;
          const d: [number, number, number] = [om.aim[0] - T[12], om.aim[1] - T[13], om.aim[2] - T[14]];
          return {
            mode: 'improve',
            target: toScreen(d, T),
            aligned: angleDeg([-T[8], -T[9], -T[10]], d) <= AIM_DEG,
            hold: 0,
            progress: om.progress,
            done: false,
            heightDeviation: 0,
            inBand: true,
            buzzing: false,
            focal: v.pose.focal,
            imageWidth: v.pose.imageWidth,
            imageHeight: v.pose.imageHeight,
          };
        })()
      : null;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View
        ref={wrapRef}
        style={styles.previewWrap}
        onLayout={(e) => {
          setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
          wrapRef.current?.measureInWindow((x, y) => {
            wrapOffset.current = { x, y };
          });
        }}
        // Taps on the empty preview: metering during a vista pass, corners
        // while adding an opening. Buttons answer first; page coordinates
        // because locationX is relative to whichever child was touched.
        onStartShouldSetResponder={() => v.tapsActive}
        onResponderRelease={(e) =>
          v.onTap(e.nativeEvent.pageX - wrapOffset.current.x, e.nativeEvent.pageY - wrapOffset.current.y)
        }
      >
        {ArkitPreviewView ? <ArkitPreviewView style={StyleSheet.absoluteFill} /> : null}
        {recording && !v.vistaRole && v.pose && size.width > 0 ? (
          <OpeningsOverlay
            pose={v.pose}
            openings={v.openings}
            names={v.names}
            taps={v.addTaps}
            width={size.width}
            height={size.height}
          />
        ) : null}
        {recording && !v.vistaRole && v.pose && size.width > 0 ? (
          <ObjectOverlay pose={v.pose} om={om} floorY={v.floorY()} width={size.width} height={size.height} />
        ) : null}
        {!v.vistaRole && !v.addTaps && guiding && guide && !inObject && size.width > 0 ? (
          <GuidanceOverlay g={guide} width={size.width} height={size.height} />
        ) : null}
        {objectGuide && size.width > 0 ? (
          <GuidanceOverlay g={objectGuide} width={size.width} height={size.height} hideHeight />
        ) : null}
        {v.vistaGuide && size.width > 0 ? (
          <GuidanceOverlay g={v.vistaGuide} width={size.width} height={size.height} />
        ) : null}

        <View style={styles.overlay}>
          <View style={styles.topBar}>
            <Text style={styles.counter}>
              {frameCount} kare
              {inObject ? ` · ${om.currentName} %${Math.round(om.progress * 100)}` : ''}
            </Text>
            {guiding ? (
              <View style={styles.coverageRow}>
                <View style={styles.coverageTrack}>
                  <View style={[styles.coverageFill, { width: `${progressPct}%`, backgroundColor: '#4ade80' }]} />
                </View>
                <Text style={styles.coverageLabel}>%{progressPct} tamam</Text>
              </View>
            ) : (
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
            )}

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

          {showDone ? (
            <View style={styles.doneBanner}>
              <Text style={styles.pendingTitle}>Bu odada her yer tarandı</Text>
              <View style={styles.doneRow}>
                <Pressable style={styles.doneButton} onPress={toggleRecording} disabled={busy}>
                  <Text style={styles.buttonText}>Bitir</Text>
                </Pressable>
                <Pressable style={styles.doneButtonAlt} onPress={() => setDoneDismissed(true)}>
                  <Text style={styles.buttonText}>Devam et</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {inHouse && hc.house?.phase === 'pickLabels' ? <LabelPicker onDone={hc.pickLabels} /> : null}
          {inHouse && hc.house?.phase === 'resuming' ? (
            <ResumeRelocalizeOverlay
              hint={hc.hint}
              reason={hc.tracking.reason}
              onNewMap={hc.startNewMapNow}
              onCancel={() => navigation.goBack()}
            />
          ) : null}
          {inHouse && hc.house && hc.house.phase === 'roomDone' ? (
            <RoomDoneSheet
              segmentCount={hc.house.segments.length}
              uploadLine={hc.uploadLine}
              newMapNext={needsNewMap(hc.house)}
              onContinue={hc.continueHouse}
              onFinish={hc.finishHouse}
              onRetry={hc.house.segments.some((s) => s.upload === 'failed') ? hc.retryUploads : null}
            />
          ) : null}
          {inHouse && hc.house && hc.house.phase === 'finishing' ? (
            <View style={styles.pendingBanner}>
              <Text style={styles.pendingTitle}>Ev tamamlanıyor</Text>
              <Text style={styles.pendingBody}>{hc.uploadLine || 'Yükleniyor…'}</Text>
              {hc.house.segments.some((s) => s.upload === 'failed') ? (
                <Pressable onPress={hc.retryUploads}>
                  <Text style={styles.pendingTitle}>Tekrar dene</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {!inHouse && pending && !recording && !busy ? (
            <Pressable style={styles.pendingBanner} onPress={() => sendArchive(pending.archivePath)}>
              <Text style={styles.pendingTitle}>Yüklenmemiş tarama var</Text>
              <Text style={styles.pendingBody}>
                {pending.frameCount} kare, telefonda saklı. Tekrar yüklemek için dokun.
              </Text>
            </Pressable>
          ) : null}

          <View style={styles.bottomBar}>
            <Text style={styles.infoText}>
              {v.vistaRole === 'vista'
                ? `Manzara: ${v.vistaDone}/${v.vistaTotal || '…'} nokta. Dışarıda bir binaya dokun (pozlama), sonra çerçeveyi noktaya getirip sabit tut.`
                : v.vistaRole === 'control'
                  ? `Kontrol fotoğrafı: ${v.vistaDone}. Balkonun bir ucuna ya da cam önüne geç, dışarıya çevir, Çek'e bas.`
                  : v.addTaps
                    ? `Açıklık ekle: çerçevenin 4 köşesine sırayla dokun (${v.addTaps.length}/4).`
                    : v.segmentBusy
                      ? 'Bir saniye…'
                      : v.outdoor && recording
                        ? 'Dışarıdasın. Zemini ve korkuluğu tara, sonra dönüp cepheyi tara.'
                        : !recording
                ? "Telefonu göğüs hizasında tutup Başlat'a bas: yükseklik o anda sabitlenir. Sonra yeşil oku takip et; telefon titrerse yüksekliğe geri dön."
                : storageFull
                  ? 'Kayıt sınırına ulaşıldı. Durdur ve Yükle ile taramayı tamamla.'
                  : thermalState >= 3
                    ? 'Telefon çok ısındı, kare kaydı durdu. Durdur ve Yükle ile bitir.'
                  : thermalState >= 2
                    ? 'Telefon ısınıyor: kare hızı ve renk güncellemesi yavaşlatıldı. Mümkünse taramayı kısa tut.'
                  : tooFast
                    ? 'YAVAŞLA — telefon çok hızlı, kareler bulanık çıkıyor ve kaydedilmiyor.'
                  : om.hint
                    ? om.hint
                  : guiding && guide
                    ? guidanceHint(guide, size.width, size.height)
                    : coverageOk
                      ? 'İyi gidiyor. Mavi ve sarı kalan yerlere 1-3 m uzaktan, başka bir noktadan bak; yaklaşmak sayılmaz.'
                      : 'Ağ renkleri: mavi henüz iyi değil, yeşil tamam, gri LiDAR ölçemiyor (cam, ayna).'}
            </Text>
            {/* Always there: a piece that cannot be filled must never trap the user (test 2026-10-03). */}
            {recording && inObject ? (
              <View style={styles.actionRow}>
                <Pressable style={styles.smallButton} onPress={om.finishCurrent}>
                  <Text style={styles.smallText}>
                    {om.progress >= FINISH_OFFER ? `${om.currentName} tamam` : `${om.currentName} taramasını bitir`}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {recording && !inObject && !v.vistaRole && !v.addTaps ? (
              <View style={styles.actionRow}>
                <Pressable style={styles.smallButton} onPress={v.toggleOutdoor} disabled={v.segmentBusy || busy}>
                  <Text style={styles.smallText}>{v.outdoor ? 'İçeri giriyorum' : 'Dışarı çıkıyorum'}</Text>
                </Pressable>
                <Pressable style={styles.smallButton} onPress={() => v.openVista('vista')} disabled={busy}>
                  <Text style={styles.smallText}>Manzara çek</Text>
                </Pressable>
                <Pressable style={styles.smallButton} onPress={() => v.openVista('control')} disabled={busy}>
                  <Text style={styles.smallText}>Kontrol foto</Text>
                </Pressable>
                <Pressable style={styles.smallButton} onPress={v.startAdd} disabled={busy}>
                  <Text style={styles.smallText}>Açıklık ekle</Text>
                </Pressable>
              </View>
            ) : null}
            {v.vistaRole || v.addTaps ? (
              <View style={styles.actionRow}>
                {v.vistaRole === 'control' ? (
                  <Pressable style={styles.smallButton} onPress={v.shootControl}>
                    <Text style={styles.smallText}>Çek</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.smallButton} onPress={v.vistaRole ? v.closeVista : v.cancelAdd}>
                  <Text style={styles.smallText}>{v.vistaRole ? 'Bitti' : 'Vazgeç'}</Text>
                </Pressable>
              </View>
            ) : null}
            {!recording && formatLine ? <Text style={styles.probeText}>{formatLine}</Text> : null}

            <Pressable
              style={[styles.recordButton, recording && styles.recordButtonActive]}
              onPress={toggleRecording}
              disabled={
                busy || v.vistaRole !== null || v.segmentBusy ||
                (inHouse && !recording && hc.house?.phase !== 'ready')
              }
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>{recording ? (inHouse ? 'Odayı bitir' : 'Durdur ve Yükle') : 'Başlat'}</Text>
              )}
            </Pressable>
          </View>
        </View>
        {om.black ? <TransitionScreen {...om.black} /> : null}
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
  probeText: { color: 'rgba(255,255,255,0.55)', fontSize: 11, textAlign: 'center' },
  doneBanner: {
    marginHorizontal: 16,
    padding: 14,
    borderRadius: 12,
    gap: 10,
    backgroundColor: 'rgba(74,222,128,0.95)',
  },
  doneRow: { flexDirection: 'row', gap: 10 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  smallButton: {
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  smallText: { color: '#0e0e0e', fontWeight: '700', fontSize: 13 },
  doneButton: { flex: 1, backgroundColor: '#fff', borderRadius: 999, paddingVertical: 10, alignItems: 'center' },
  doneButtonAlt: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: 'center',
  },
});
