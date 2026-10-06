// Resumable archive upload (spec 2026-10-05 §8.2). The archive is cut into
// equal parts; each part is copied to its own small file and PUT to a
// presigned UploadPart URL, so no single request is large and a killed app
// resumes with only the missing parts. Progress (upload id + part etags) is
// handed to onProgress after every part, and the caller persists it.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../lib/supabase';
import type { MultipartState } from '../house/houseSession';
import { doneParts, missingParts, partRange, readEtag } from './multipartPlan';

const SIGN_BATCH = 20;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('upload-multipart', { body });
  if (error) {
    let detail = error.message;
    try {
      const j = await (error as any).context?.clone?.().json?.();
      if (j?.error) detail = j.error;
    } catch {
      /* body was not JSON */
    }
    throw new Error(`Yükleme sunucusu: ${detail}`);
  }
  return data as T;
}

export async function uploadMultipart(
  fileUri: string,
  prev: MultipartState | undefined,
  onProgress: (s: MultipartState) => Promise<void>
): Promise<MultipartState> {
  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists) throw new Error('Tarama dosyası telefonda bulunamadı');
  const size = (info as any).size as number;

  let state: MultipartState;
  if (prev && prev.size === size) {
    state = prev;
  } else {
    const init = await call<{ storage_path: string; upload_id: string; part_size: number; part_count: number }>({
      action: 'init', ext: '.zip', size,
    });
    state = {
      storagePath: init.storage_path, uploadId: init.upload_id,
      partSize: init.part_size, partCount: init.part_count, size, etags: {},
    };
    await onProgress(state);
  }

  const partFile = `${FileSystem.cacheDirectory}mp-part.bin`;
  let todo = missingParts(state);
  while (todo.length > 0) {
    const batch = todo.slice(0, SIGN_BATCH);
    const { urls } = await call<{ urls: Record<string, string> }>({
      action: 'sign', storage_path: state.storagePath, upload_id: state.uploadId, part_numbers: batch,
    });
    for (const n of batch) {
      const { position, length } = partRange(state, n);
      const b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64, position, length,
      });
      await FileSystem.writeAsStringAsync(partFile, b64, { encoding: FileSystem.EncodingType.Base64 });
      const res = await FileSystem.uploadAsync(urls[String(n)], partFile, {
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      });
      const etag = readEtag(res.headers ?? {});
      if (res.status < 200 || res.status >= 300 || !etag) {
        throw new Error(`Parça ${n}/${state.partCount} yüklenemedi (HTTP ${res.status})`);
      }
      state = { ...state, etags: { ...state.etags, [n]: etag } };
      await onProgress(state);
    }
    todo = missingParts(state);
  }
  await FileSystem.deleteAsync(partFile, { idempotent: true });

  await call({
    action: 'complete', storage_path: state.storagePath, upload_id: state.uploadId,
    part_count: state.partCount, parts: doneParts(state),
  });
  return state;
}
