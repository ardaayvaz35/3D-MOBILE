import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ActivityIndicator, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getCaptureStatus } from '../api/captures';
import { downloadAndShareSplat } from '../api/exportSplat';
import type { CaptureDetail } from '../types/capture';

type Props = NativeStackScreenProps<RootStackParamList, 'CaptureDetail'>;

export default function CaptureDetailScreen({ route, navigation }: Props) {
  const { captureId } = route.params;
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  useEffect(() => {
    getCaptureStatus(captureId).then(setDetail).catch(() => {});
  }, [captureId]);

  const handleExport = async () => {
    setExporting(true);
    setExportStatus('');
    try {
      await downloadAndShareSplat(captureId, setExportStatus);
    } catch (err: any) {
      Alert.alert('Dışa aktarma hatası', err?.message ?? String(err));
    } finally {
      setExporting(false);
      setExportStatus('');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <Text style={styles.title}>Tarama Hazır ✓</Text>
        <Text style={styles.captureId}>ID: {captureId.slice(0, 8)}...</Text>
        {detail?.created_at ? (
          <Text style={styles.meta}>
            {new Date(detail.created_at).toLocaleString('tr-TR')}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={styles.primaryButton}
            onPress={() => navigation.navigate('Viewer', { captureId })}
          >
            <Text style={styles.primaryButtonText}>3D Görüntüle / Keşfet</Text>
          </Pressable>

          <Pressable
            style={[styles.secondaryButton, exporting && styles.buttonDisabled]}
            onPress={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <View style={styles.row}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.secondaryButtonText}>{exportStatus || 'Hazırlanıyor...'}</Text>
              </View>
            ) : (
              <Text style={styles.secondaryButtonText}>Dışa Aktar (.ply)</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.hint}>
          Dışa Aktar, ham splat (.ply) dosyasını cihazına indirip paylaşım
          menüsünü açar. Buradan AirDrop ile Mac'e gönderip SuperSplat
          editöründe (File → Import) açabilirsin.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },
  body: { flex: 1, padding: 24, justifyContent: 'center', gap: 8 },
  title: { color: '#4ade80', fontSize: 22, fontWeight: '700' },
  captureId: { color: '#666', fontSize: 12, marginTop: 4 },
  meta: { color: '#9a9a9e', fontSize: 13 },
  actions: { gap: 12, marginTop: 32 },
  primaryButton: {
    backgroundColor: '#4ade80',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#0e0e0e', fontWeight: '700', fontSize: 15 },
  secondaryButton: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  secondaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  buttonDisabled: { opacity: 0.7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hint: { color: '#666', fontSize: 12, lineHeight: 18, marginTop: 24 },
});
