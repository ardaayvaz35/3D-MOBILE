// "Ev tara" (spec §4.1 steps 1, 6): start a new house or continue one.
import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { createProperty } from '../api/houses';
import { newHouse, type House } from '../house/houseSession';
import { listLocalHouses, newMapId, removeHouse, saveHouse } from '../house/houseStore';

type Props = NativeStackScreenProps<RootStackParamList, 'HouseStart'>;

export default function HouseStartScreen({ navigation }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [houses, setHouses] = useState<House[]>([]);

  useFocusEffect(
    useCallback(() => {
      listLocalHouses().then((hs) => setHouses(hs.filter((h) => h.phase !== 'finished')));
    }, [])
  );

  const start = async () => {
    setBusy(true);
    try {
      const p = await createProperty(name);
      await saveHouse(newHouse(p.property_id, p.name, new Date(), newMapId()));
      navigation.replace('LidarScan', { house: { propertyId: p.property_id, resume: false } });
    } catch (e: any) {
      Alert.alert('Hata', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = (h: House) =>
    Alert.alert('Evi listeden kaldır', `${h.name} telefondan silinsin mi? Yüklenmiş bölümler sunucuda kalır.`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Kaldır', style: 'destructive',
        onPress: async () => {
          await removeHouse(h.propertyId);
          setHouses((hs) => hs.filter((x) => x.propertyId !== h.propertyId));
        },
      },
    ]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Yeni ev</Text>
        <TextInput
          style={styles.input}
          placeholder="Ev adı (isteğe bağlı)"
          placeholderTextColor="#777"
          value={name}
          onChangeText={setName}
          maxLength={80}
        />
        <Pressable style={styles.main} onPress={start} disabled={busy}>
          {busy ? <ActivityIndicator color="#111" /> : <Text style={styles.mainText}>Taramaya başla</Text>}
        </Pressable>

        {houses.length ? <Text style={styles.title}>Devam eden evler</Text> : null}
        {houses.map((h) => (
          <View key={h.propertyId} style={styles.card}>
            <Text style={styles.cardTitle}>{h.name}</Text>
            <Text style={styles.cardLine}>
              Devam ediyor · {h.segments.length} bölüm ·{' '}
              {h.segments.filter((s) => s.upload === 'uploaded').length} yüklendi
            </Text>
            <View style={styles.row}>
              <Pressable
                style={styles.small}
                onPress={() => navigation.navigate('LidarScan', { house: { propertyId: h.propertyId, resume: true } })}
              >
                <Text style={styles.smallText}>Devam et</Text>
              </Pressable>
              <Pressable style={styles.smallAlt} onPress={() => forget(h)}>
                <Text style={styles.smallText}>Kaldır</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },
  body: { padding: 20, gap: 14 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 8 },
  input: { borderRadius: 12, padding: 14, backgroundColor: '#1c1c1e', color: '#fff', fontSize: 16 },
  main: { paddingVertical: 16, borderRadius: 999, backgroundColor: '#4ade80', alignItems: 'center' },
  mainText: { color: '#0e0e0e', fontWeight: '700', fontSize: 16 },
  card: { padding: 14, borderRadius: 12, backgroundColor: '#1c1c1e', gap: 6 },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardLine: { color: '#aaa', fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, marginTop: 4 },
  small: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#4ade80' },
  smallAlt: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#444' },
  smallText: { color: '#fff', fontWeight: '700' },
});
