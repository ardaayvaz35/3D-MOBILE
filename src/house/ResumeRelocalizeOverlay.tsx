// Reopened house (spec §4.1 step 6, §8.2): recording stays locked until ARKit
// recognises the saved map. 60 s: tips. 120 s: offer a new map.
import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';

type Props = {
  hint: 'none' | 'hint' | 'offerNewMap';
  reason: string;
  onNewMap: () => void;
  onCancel: () => void;
};

export default function ResumeRelocalizeOverlay({ hint, reason, onNewMap, onCancel }: Props) {
  return (
    <View style={styles.box}>
      <ActivityIndicator color="#fff" />
      <Text style={styles.title}>Son taradığın yere bak</Text>
      <Text style={styles.body}>
        Telefon evi tanıyınca kayıt açılır.
        {hint !== 'none' ? '\nDaha yavaş gez, ışığı aç, son taradığın bölümün belirgin bir köşesine bak.' : ''}
        {reason === 'excessiveMotion' ? '\nÇok hızlı hareket ediyorsun, yavaşla.' : ''}
      </Text>
      {hint === 'offerNewMap' ? (
        <Pressable style={styles.btn} onPress={onNewMap}>
          <Text style={styles.btnText}>Yeni harita ile devam et</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.btnAlt} onPress={onCancel}>
        <Text style={styles.btnAltText}>Vazgeç</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { margin: 16, padding: 18, borderRadius: 14, gap: 10, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.75)' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  body: { color: '#fff', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: { alignSelf: 'stretch', paddingVertical: 12, borderRadius: 999, backgroundColor: '#eab308', alignItems: 'center' },
  btnText: { color: '#111', fontWeight: '700' },
  btnAlt: { alignSelf: 'stretch', paddingVertical: 10, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center' },
  btnAltText: { color: '#fff', fontWeight: '700' },
});
