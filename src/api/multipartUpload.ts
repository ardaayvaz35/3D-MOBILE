// Resumable archive upload (spec 2026-10-05 §8.2). The archive is cut into
// equal parts; each part is copied to its own small file and PUT to a
// presigned UploadPart URL, so no single request is large and a killed app
// resumes with only the missing parts. Progress (upload id + part etags) is
// handed to onProgress after every part, and the caller persists it.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../lib/supabase';
import type { MultipartState } from '../house/houseSession';
import { doneParts, isStale, missingParts, partRange, readEtag } from './multipartPlan';

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
  onProgress: (s: MultipartState) => Promise<void>,
  reinitUsed = false
): Promise<MultipartState> {
  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists) throw new Error('Tarama dosyası telefonda bulunamadı');
  const size = (info as any).size as number;

  const initState = async (): Promise<MultipartState> => {
    const init = await call<{ storage_path: string; upload_id: string; part_size: number; part_count: number }>({
      action: 'init', ext: '.zip', size,
    });
    const fresh: MultipartState = {
      storagePath: init.storage_path, uploadId: init.upload_id,
      partSize: init.part_size, partCount: init.part_count, size, etags: {}, startedAt: Date.now(),
    };
    await onProgress(fresh);
    return fresh;
  };

  let state: MultipartState =
    prev && prev.size === size && !isStale(prev, Date.now()) ? prev : await initState();

  const partFile = `${FileSystem.cacheDirectory}mp-part.bin`;
  // R2 answers NoSuchUpload for an aborted upload: start over once, from part 1.
  let reinitDone = reinitUsed;
  const gone = (e: unknown) => e instanceof Error && e.message.includes('NoSuchUpload');
  const withReinit = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (!gone(e) || reinitDone) throw e;
      reinitDone = true;
      state = await initState();
      return undefined;
    }
  };

  let todo = missingParts(state);
  while (todo.length > 0) {
    const batch = todo.slice(0, SIGN_BATCH);
    const signed = await withReinit(() =>
      call<{ urls: Record<string, string> }>({
        action: 'sign', storage_path: state.storagePath, upload_id: state.uploadId, part_numbers: batch,
      })
    );
    if (!signed) {
      todo = missingParts(state);
      continue;
    }
    const { urls } = signed;
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

  const completeBody = () => ({
    action: 'complete', storage_path: state.storagePath, upload_id: state.uploadId,
    part_count: state.partCount, parts: doneParts(state),
  });
  try {
    await call(completeBody());
  } catch (e) {
    if (!gone(e) || reinitDone) throw e;
    // Aborted before complete: a re-init needs every part again; restart the whole upload once.
    return uploadMultipart(fileUri, undefined, onProgress, true);
  }
  return state;
}
