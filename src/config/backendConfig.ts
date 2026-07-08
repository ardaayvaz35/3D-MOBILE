import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const STORAGE_KEY = 'backend_base_url';
const BACKEND_PORT = 8000;
// Last-resort fallback if we can't derive the host from the Expo dev server.
const FALLBACK_URL = `http://192.168.1.100:${BACKEND_PORT}`;

let cachedUrl: string | null = null;

/**
 * Derive the backend URL from the Expo dev-server host.
 *
 * The Metro bundler and the FastAPI backend run on the SAME machine (the
 * user's PC). Expo tells the app which host it loaded from via
 * `Constants.expoConfig.hostUri` (e.g. "172.20.10.5:8081"). We reuse that
 * host and just swap the port to 8000. This makes the backend reachable out
 * of the box on whatever network the phone + PC share (home Wi-Fi, hotspot,
 * etc.) without the user ever hand-typing an IP.
 */
function deriveDefaultUrl(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    // Older/newer Expo runtimes expose it in slightly different places.
    (Constants as any).expoGoConfig?.debuggerHost ||
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost ||
    '';

  const host = String(hostUri).split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:${BACKEND_PORT}`;
  }
  return FALLBACK_URL;
}

export async function getBackendUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  cachedUrl = stored || deriveDefaultUrl();
  return cachedUrl;
}

export async function setBackendUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/+$/, '');
  cachedUrl = trimmed;
  await AsyncStorage.setItem(STORAGE_KEY, trimmed);
}

/**
 * Clear any manually-saved URL and fall back to auto-derivation.
 * Useful when the phone moves to a new network and the old saved IP is stale.
 */
export async function resetBackendUrl(): Promise<void> {
  cachedUrl = null;
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export function getDefaultBackendUrl(): string {
  return deriveDefaultUrl();
}
