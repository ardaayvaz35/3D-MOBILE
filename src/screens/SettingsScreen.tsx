import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Alert } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabase';

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const [creditsBalance, setCreditsBalance] = useState<number | null>(null);

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
      { text: 'Çıkış Yap', style: 'destructive', onPress: () => signOut().catch(() => {}) },
    ]);
  };

  return (
    <SafeAreaView style={styles.container}>
      {user && (
        <View style={styles.profileCard}>
          <Text style={styles.profileEmail}>{user.email}</Text>
          {creditsBalance !== null && (
            <Text style={styles.profileCredits}>Kredi bakiyesi: {creditsBalance}</Text>
          )}
          <Pressable style={styles.signOutButton} onPress={handleSignOut}>
            <Text style={styles.signOutText}>Çıkış Yap</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.hint}>
        Tarama işleme tamamen bulutta (Supabase + RunPod GPU) çalışır — ayarlanacak bir
        sunucu adresi yoktur. Bir tarama yüklediğinde otomatik olarak işlenir.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e', padding: 20, gap: 12 },
  profileCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
    gap: 6,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  profileEmail: { color: '#fff', fontSize: 15, fontWeight: '600' },
  profileCredits: { color: '#4ade80', fontSize: 13 },
  signOutButton: { marginTop: 8 },
  signOutText: { color: '#f87171', fontSize: 14, fontWeight: '600' },
  hint: { color: '#666', fontSize: 12, marginTop: 8, lineHeight: 17 },
});
