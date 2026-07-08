import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, Alert } from 'react-native';
import { getBackendUrl, setBackendUrl, getDefaultBackendUrl, resetBackendUrl } from '../config/backendConfig';
import { checkBackendHealth } from '../api/captures';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabase';

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [creditsBalance, setCreditsBalance] = useState<number | null>(null);

  useEffect(() => {
    getBackendUrl().then(setUrl);
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

  const save = async () => {
    await setBackendUrl(url || getDefaultBackendUrl());
    Alert.alert('Kaydedildi', 'Backend adresi güncellendi.');
  };

  const testConnection = async () => {
    await setBackendUrl(url || getDefaultBackendUrl());
    setChecking(true);
    const ok = await checkBackendHealth();
    setStatus(ok ? 'ok' : 'fail');
    setChecking(false);
  };

  const autoDetect = async () => {
    await resetBackendUrl();
    const detected = await getBackendUrl();
    setUrl(detected);
    Alert.alert('Otomatik algılandı', detected);
  };

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

      <Text style={styles.label}>Backend URL</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder={getDefaultBackendUrl()}
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={save}>
          <Text style={styles.buttonText}>Kaydet</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={testConnection}>
          <Text style={styles.buttonText}>{checking ? 'Kontrol ediliyor...' : 'Bağlantıyı Test Et'}</Text>
        </Pressable>
      </View>

      <Pressable onPress={autoDetect} hitSlop={8}>
        <Text style={styles.autoLink}>↻ Otomatik algıla (aynı ağdaki PC)</Text>
      </Pressable>

      {status === 'ok' && <Text style={styles.ok}>✓ Backend'e ulaşıldı</Text>}
      {status === 'fail' && (
        <Text style={styles.fail}>
          ✗ Backend'e ulaşılamadı. IP ve portu kontrol et, aynı Wi-Fi ağında olduğunuzdan emin olun.
        </Text>
      )}

      <Text style={styles.hint}>
        Backend adresi normalde otomatik algılanır (uygulamayı hangi PC'den açtıysan
        onun IP'si + 8000 portu). Yalnızca otomatik algılama başarısız olursa elle gir:
        {'\n'}örn: http://192.168.1.42:8000
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
  label: { color: '#9a9a9e', fontSize: 13 },
  input: {
    backgroundColor: '#1c1c1e',
    color: '#fff',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  row: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    backgroundColor: '#4ade80',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  secondaryButton: { backgroundColor: '#2c2c2e' },
  buttonText: { color: '#0e0e0e', fontWeight: '700' },
  autoLink: { color: '#4a9eff', fontSize: 13, marginTop: 2 },
  ok: { color: '#4ade80' },
  fail: { color: '#f87171' },
  hint: { color: '#666', fontSize: 12, marginTop: 8, lineHeight: 17 },
});
