import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { listCaptures, type CaptureListItem } from '../api/captures';
import { listProperties, type PropertyRow } from '../api/houses';
import { LABEL_NAMES } from '../house/houseSession';
import type { CaptureStatusValue, ClientType } from '../types/capture';

type Props = NativeStackScreenProps<RootStackParamList, 'MyScans'>;

const STATUS_LABELS: Record<CaptureStatusValue, string> = {
  uploaded: 'Yüklendi',
  queued: 'Sırada',
  sfm_running: 'İşleniyor',
  training: 'Eğitiliyor',
  exporting: 'Dışa aktarılıyor',
  done: 'Hazır ✓',
  failed: 'Başarısız',
  unknown: 'Bilinmiyor',
};

const STATUS_COLORS: Record<CaptureStatusValue, string> = {
  uploaded: '#eab308',
  queued: '#eab308',
  sfm_running: '#4a9eff',
  training: '#4a9eff',
  exporting: '#4a9eff',
  done: '#4ade80',
  failed: '#f87171',
  unknown: '#9a9a9e',
};

const CLIENT_LABELS: Record<ClientType, string> = {
  ios_lidar: 'LiDAR',
  android_arcore: 'ARCore',
  web_photo: 'Foto',
  web_video: 'Video',
};

const IN_PROGRESS: CaptureStatusValue[] = [
  'uploaded',
  'queued',
  'sfm_running',
  'training',
  'exporting',
];

const PROPERTY_STATUS_LABELS: Record<string, string> = {
  scanning: 'Taranıyor',
  processing: 'İşleniyor',
  ready: 'Hazır ✓',
  failed: 'Başarısız',
};

type ListRow =
  | { kind: 'house'; property: PropertyRow }
  | { kind: 'capture'; capture: CaptureListItem; inHouse: boolean };

function segmentTitle(c: CaptureListItem): string {
  if (c.labels && c.labels.length) {
    return c.labels.map((l) => (LABEL_NAMES as Record<string, string>)[l] ?? l).join(' + ');
  }
  return `Bölüm ${(c.segment_index ?? 0) + 1}`;
}

// Each house gets a header row followed by its segments in scan order; scans
// without a house (or whose house is unknown) follow as before.
function buildRows(captures: CaptureListItem[], properties: PropertyRow[]): ListRow[] {
  const known = new Set(properties.map((p) => p.id));
  const rows: ListRow[] = [];
  for (const property of properties) {
    rows.push({ kind: 'house', property });
    captures
      .filter((c) => c.property_id === property.id)
      .sort((a, b) => (a.segment_index ?? 0) - (b.segment_index ?? 0))
      .forEach((capture) => rows.push({ kind: 'capture', capture, inHouse: true }));
  }
  captures
    .filter((c) => !c.property_id || !known.has(c.property_id))
    .forEach((capture) => rows.push({ kind: 'capture', capture, inHouse: false }));
  return rows;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function MyScansScreen({ navigation }: Props) {
  const [items, setItems] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [captures, properties] = await Promise.all([
        listCaptures(),
        // Grouping is optional: without the properties table, scans show ungrouped.
        listProperties().catch((e) => {
          console.log('[myscans] listProperties failed, showing ungrouped:', e?.message ?? e);
          return [] as PropertyRow[];
        }),
      ]);
      setItems(buildRows(captures, properties));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload every time the screen comes into focus so a freshly-finished
  // scan shows up without the user having to pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const openScan = (item: CaptureListItem) => {
    if (item.status === 'done') {
      navigation.navigate('CaptureDetail', { captureId: item.id });
    } else if (item.status !== 'failed') {
      navigation.navigate('Status', { captureId: item.id });
    }
  };

  const renderItem = ({ item: row }: { item: ListRow }) => {
    if (row.kind === 'house') {
      const p = row.property;
      return (
        <View style={styles.houseHeader}>
          <Text style={styles.houseTitle}>
            🏠 {p.name} · {p.room_count} bölüm · {PROPERTY_STATUS_LABELS[p.status] ?? p.status}
          </Text>
        </View>
      );
    }
    const item = row.capture;
    const inProgress = IN_PROGRESS.includes(item.status);
    return (
      <Pressable
        style={[styles.card, row.inHouse && styles.cardInHouse]}
        onPress={() => openScan(item)}
        disabled={item.status === 'failed'}
      >
        <View style={styles.cardLeft}>
          <View style={[styles.thumb, { borderColor: STATUS_COLORS[item.status] }]}>
            {inProgress ? (
              <ActivityIndicator color={STATUS_COLORS[item.status]} size="small" />
            ) : (
              <Text style={[styles.thumbIcon, { color: STATUS_COLORS[item.status] }]}>
                {item.status === 'done' ? '◆' : item.status === 'failed' ? '✕' : '•'}
              </Text>
            )}
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardTitle}>
              {row.inHouse
                ? segmentTitle(item)
                : `${CLIENT_LABELS[item.client_type] ?? item.client_type} taraması`}
            </Text>
            <Text style={styles.cardDate}>{formatDate(item.created_at)}</Text>
          </View>
        </View>
        <Text style={[styles.statusBadge, { color: STATUS_COLORS[item.status] }]}>
          {STATUS_LABELS[item.status]}
        </Text>
      </Pressable>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color="#4ade80" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(row) => (row.kind === 'house' ? `house-${row.property.id}` : row.capture.id)}
        renderItem={renderItem}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4ade80" />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            {error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <>
                <Text style={styles.emptyTitle}>Henüz taraman yok</Text>
                <Text style={styles.emptySubtitle}>
                  Ana ekrandan video veya foto ile bir tarama başlat. Hazır olan splat
                  dosyaların burada görünecek.
                </Text>
              </>
            )}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  listContent: { padding: 16, gap: 12 },
  emptyWrap: { flexGrow: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  cardInHouse: { marginLeft: 16 },
  houseHeader: { paddingTop: 8 },
  houseTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0e0e0e',
  },
  thumbIcon: { fontSize: 18, fontWeight: '700' },
  cardInfo: { flex: 1, gap: 3 },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cardDate: { color: '#9a9a9e', fontSize: 12 },
  statusBadge: { fontSize: 13, fontWeight: '700', marginLeft: 8 },
  emptyTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  emptySubtitle: { color: '#9a9a9e', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  error: { color: '#f87171', fontSize: 14, textAlign: 'center' },
});
