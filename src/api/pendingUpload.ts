// A scan that was captured but not yet handed to the server.
//
// Why this exists: the archive lives in the OS temp directory and the only
// reference to it was a local variable inside finishAndUpload(). If anything
// interrupted that function -- a failed upload, a lost network, or iOS
// terminating the app during the heaviest step of the whole flow -- the path
// went with it and a scan the user had spent minutes walking around a room
// collecting was simply gone, with nothing on screen to say so.
//
// Recording the path before the upload starts makes the archive recoverable
// across an app restart, which is exactly the case that used to lose it.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { ClientType } from '../types/capture';

const KEY = 'pendingUpload.v1';

export type PendingUpload = {
  archivePath: string;
  clientType: ClientType;
  frameCount: number;
  savedAt: string;
};

export async function savePendingUpload(p: Omit<PendingUpload, 'savedAt'>): Promise<void> {
  const record: PendingUpload = { ...p, savedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(record));
  } catch (e) {
    // Never let bookkeeping break the upload it is supposed to protect.
    console.log('[pending] could not save', e);
  }
}

/// Returns the pending upload only if its archive is still on disk. iOS can
/// purge the temp directory, and offering a retry that cannot possibly work
/// is worse than saying nothing.
export async function loadPendingUpload(): Promise<PendingUpload | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as PendingUpload;
    const info = await FileSystem.getInfoAsync(`file://${record.archivePath}`);
    if (!info.exists) {
      await clearPendingUpload();
      return null;
    }
    return record;
  } catch (e) {
    console.log('[pending] could not load', e);
    return null;
  }
}

export async function clearPendingUpload(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (e) {
    console.log('[pending] could not clear', e);
  }
}
