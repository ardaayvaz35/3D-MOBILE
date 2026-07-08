import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { isArkitModuleAvailable, isLidarSupported } from '../native/arkitCapture';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabase';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const { user, signOut } = useAuth();
  const [creditsBalance, setCreditsBalance] = useState<number | null>(null);
  const lidarReady = isArkitModuleAvailable() && isLidarSupported();

  useEffect(() => {
    if (user) {
      supabase
        .from('profiles')
        .select('credits_balance')
        .eq('id', user.id)
        .single()
        .then(
          ({ data }) => {
            if (data) setCreditsBalance(data.credits_balance);
          },
          () => {}
        );
    }
  }, [user]);

  const handleSignOut = () => {
    Alert.alert('Çıkış Yap', 'Hesabından çıkış yapmak istediğine emin misin?', [
      { text: 'İptal', style: 'cancel' },
      {
        text: 'Çıkış Yap',
        style: 'destructive',
        onPress: () => signOut().catch(() => {}),
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>3D Scanner</Text>
          {creditsBalance !== null && (
            <Text style={styles.credits}>{creditsBalance} kredi</Text>
          )}
        </View>
        <View style={styles.headerRight}>
          <Pressable onPress={() => navigation.navigate('MyScans')} hitSlop={12}>
            <Text style={styles.settingsLink}>Taramalarım</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={12}>
            <Text style={styles.settingsLink}>Ayarlar</Text>
          </Pressable>
          <Pressable onPress={handleSignOut} hitSlop={12}>
            <Text style={styles.signOut}>Çıkış</Text>
          </Pressable>
        </View>
      </View>

      {user && <Text style={styles.userEmail}>{user.email}</Text>}

      <View style={styles.body}>
        <Pressable
          style={[styles.card, !lidarReady && styles.cardDisabled]}
          onPress={() => navigation.navigate('LidarScan')}
        >
          <Text style={styles.cardTitle}>LiDAR ile Tara</Text>
          <Text style={styles.cardSubtitle}>
            {lidarReady
              ? 'ARKit derinlik + poz verisiyle yüksek kaliteli tarama (ana özellik)'
              : 'Bu build\'de mevcut değil. Dev Client (EAS build) gerekli — Mac\'te kurulacak.'}
          </Text>
        </Pressable>

        <Pressable style={styles.card} onPress={() => navigation.navigate('PhotoScan')}>
          <Text style={styles.cardTitle}>Foto ile Test Et</Text>
          <Text style={styles.cardSubtitle}>
            Expo Go uyumlu test modu — sadece RGB foto ile upload/status/viewer akışını
            uçtan uca doğrulamak için. Ana özellik LiDAR'dır.
          </Text>
        </Pressable>

        <Pressable style={styles.card} onPress={() => navigation.navigate('VideoScan')}>
          <Text style={styles.cardTitle}>Video ile Tara</Text>
          <Text style={styles.cardSubtitle}>
            Expo Go uyumlu — objenin etrafında video çekip yükle, Nerfstudio videodan
            otomatik kare çıkarıp işler.
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  credits: { color: '#4ade80', fontSize: 13, marginTop: 2 },
  headerRight: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  settingsLink: { color: '#4ade80', fontSize: 15 },
  signOut: { color: '#f87171', fontSize: 15 },
  userEmail: { color: '#666', fontSize: 12, paddingHorizontal: 20, marginTop: 4 },
  body: { flex: 1, padding: 20, justifyContent: 'center', gap: 16 },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    padding: 20,
    gap: 8,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  cardDisabled: { opacity: 0.55 },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  cardSubtitle: { color: '#9a9a9e', fontSize: 13, lineHeight: 18 },
});
