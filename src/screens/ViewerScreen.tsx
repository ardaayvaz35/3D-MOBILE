import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getViewerUrl } from '../api/captures';

type Props = NativeStackScreenProps<RootStackParamList, 'Viewer'>;

export default function ViewerScreen({ route }: Props) {
  const { captureId } = route.params;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    getViewerUrl(captureId).then(setUrl);
  }, [captureId]);

  if (!url) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#4ade80" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        source={{ uri: url }}
        style={styles.webview}
        allowsInlineMediaPlayback
        javaScriptEnabled
        originWhitelist={['*']}
        renderError={() => (
          <View style={styles.center}>
            <Text style={styles.errorText}>Viewer yüklenemedi. Backend'in /viewer altında statik olarak yayınlandığından emin ol.</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  webview: { flex: 1, backgroundColor: '#1a1a1a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a1a', padding: 24 },
  errorText: { color: '#f87171', textAlign: 'center' },
});
