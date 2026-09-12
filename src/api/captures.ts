// Capture API. Auth, the `captures` table and credits are Supabase; the blobs
// (capture archives and tour output) live in Cloudflare R2.
//
// Flow:
//   1. Ask `create-upload-url` for a presigned PUT and stream the archive
//      there. R2 has no practical per-object limit, which is what lets the
//      phone send full-resolution frames; the old Supabase Storage path is
//      kept as a fallback and is capped at 50 MB per object.
//   2. Call the `submit-capture` Edge Function, which holds the RunPod secret,
//      charges credits, creates the captures row, and triggers the GPU.
//   3. Read status + list directly from the `captures` table via RLS. The
//      finished tour is public (see tourUrl); the archive .ply is private and
//      signed on demand.

import * as FileSystem from 'expo-file-system/legacy';
import { CaptureDetail, CaptureStatusValue, ClientType, UploadResponse } from '../types/capture';
import { supabase } from '../lib/supabase';

const UPLOAD_BUCKET = 'capture-uploads';
const SPLATS_BUCKET = 'splats';
const SIGNED_URL_TTL = 3600;

// Public base for finished tour files. The worker writes the SOG files to a
// public bucket -- they have to be public, because meta.json fetches its
// sibling .webp files by relative path and a signed URL per file would break
// those. Set EXPO_PUBLIC_R2_PUBLIC_BASE to the R2 bucket's r2.dev address (or
// a custom domain); without it we fall back to Supabase's public tours bucket.
const TOURS_PUBLIC_BASE =
  process.env.EXPO_PUBLIC_R2_PUBLIC_BASE?.replace(/\/$/, '') ??
  `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/tours`;

// Where the WebView viewer is hosted. Defaults to the public viewer bucket on
// Supabase Storage; override with EXPO_PUBLIC_VIEWER_URL if you host it
// elsewhere (e.g. a GitHub Pages / CDN build).
const VIEWER_URL =
  process.env.EXPO_PUBLIC_VIEWER_URL ??
  `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/viewer/index.html`;

export type LocalArchive = {
  uri: string;
  name: string;
  mimeType: string;
};

async function requireUserId(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error('Oturum bulunamadı, tekrar giriş yap');
  return session.user.id;
}

type UploadTarget = {
  backend: 'r2' | 'supabase';
  uploadUrl: string;
  storagePath: string;
};

/// Ask the server for a presigned R2 URL, falling back to a Supabase signed
/// upload URL. The R2 key is minted server-side (the client must not name its
/// own path -- `submit-capture` authorises a capture by checking the path is
/// under the caller's own user id).
async function resolveUploadTarget(ext: string, mimeType: string): Promise<UploadTarget> {
  try {
    const { data, error } = await supabase.functions.invoke('create-upload-url', {
      body: { ext, content_type: mimeType },
    });
    if (!error && data?.upload_url && data?.storage_path) {
      return { backend: 'r2', uploadUrl: data.upload_url, storagePath: data.storage_path };
    }
    // 501 r2_not_configured is expected until the bucket credentials are set;
    // anything else is worth seeing in the log but is equally non-fatal.
    console.log('[upload] R2 unavailable, using Supabase Storage:', (error as any)?.context?.error ?? error?.message);
  } catch (e: any) {
    console.log('[upload] create-upload-url threw, using Supabase Storage:', e?.message ?? e);
  }

  const userId = await requireUserId();
  const folder = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const storagePath = `${folder}/frames${ext}`;
  const { data: signed, error: signErr } = await supabase.storage
    .from(UPLOAD_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Yükleme URL'si alınamadı: ${signErr?.message ?? 'bilinmeyen hata'}`);
  }
  return { backend: 'supabase', uploadUrl: signed.signedUrl, storagePath };
}

export async function uploadCapture(
  archive: LocalArchive,
  clientType: ClientType
): Promise<UploadResponse> {
  const ext = /\.(tar\.gz|tgz)$/i.test(archive.name) ? '.tar.gz' : '.zip';

  const info = await FileSystem.getInfoAsync(archive.uri);
  const sizeBytes = (info as any).size ?? 0;
  console.log('[upload] archive', archive.uri, 'exists:', info.exists, 'size:', sizeBytes);

  // Where does this archive go? R2 has no practical per-object limit, which is
  // what allows full-resolution frames; Supabase Storage caps a single object
  // at 50 MB on the free plan. Prefer R2 and keep the old path as a fallback so
  // capture keeps working if R2 is not configured yet.
  const target = await resolveUploadTarget(ext, archive.mimeType);
  console.log('[upload] target:', target.backend, target.storagePath);

  // Stream the archive straight from disk. Reading a large scan zip into a JS
  // string/ArrayBuffer blows past the engine's string-length limit, so we PUT
  // it with expo-file-system, which streams without materializing the file.
  const uploadRes = await FileSystem.uploadAsync(target.uploadUrl, archive.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': archive.mimeType },
  });
  console.log('[upload] upload HTTP status:', uploadRes.status);

  if (uploadRes.status === 413) {
    // Only reachable on the Supabase fallback: its free plan is fixed at 50 MB
    // per object and cannot be raised. Showing the raw body tells the user
    // nothing, so explain the actual constraint.
    const sizeMb = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) : '?';
    throw new Error(
      `Tarama dosyası çok büyük (${sizeMb} MB). Yedek depolama tek dosyada en fazla ` +
        '50 MB kabul ediyor. Bulut depolama ayarlanınca bu sınır kalkacak.'
    );
  }
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(
      `Yükleme başarısız (HTTP ${uploadRes.status}): ${uploadRes.body?.slice(0, 200) ?? ''}`
    );
  }
  const storagePath = target.storagePath;
  console.log('[upload] file uploaded, invoking submit-capture...');

  // Hand off to the Edge Function (credits + GPU trigger).
  const { data, error } = await supabase.functions.invoke('submit-capture', {
    body: { client_type: clientType, storage_path: storagePath },
  });
  if (error) {
    // Surface the function's structured error (e.g. insufficient_credits).
    const ctx = (error as any).context;
    const detail = ctx?.error ?? error.message;
    console.log('[upload] submit-capture FAILED', detail, error);
    throw new Error(`İşleme başlatılamadı: ${detail}`);
  }
  console.log('[upload] submit-capture OK, capture_id:', data?.capture_id);

  return { capture_id: data.capture_id, status: data.status ?? 'uploaded', message: 'Yüklendi' };
}

export type CaptureListItem = {
  id: string;
  status: CaptureStatusValue;
  client_type: ClientType;
  created_at: string;
};

export async function listCaptures(): Promise<CaptureListItem[]> {
  const { data, error } = await supabase
    .from('captures')
    .select('id, status, client_type, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Taramalar alınamadı: ${error.message}`);
  return (data ?? []) as CaptureListItem[];
}

/// Public URL for a finished tour (the SOG `meta.json` and its siblings).
/// Not signed: meta.json fetches the .webp files next to it by relative path,
/// so every file has to be reachable under one public prefix.
function tourUrl(path: string | null | undefined): string | null {
  return path ? `${TOURS_PUBLIC_BASE}/${path}` : null;
}

/// Signed URL for a private object (the archive .ply in the `splats` bucket).
async function signedUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(SPLATS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function getCaptureStatus(captureId: string): Promise<CaptureDetail> {
  const { data, error } = await supabase
    .from('captures')
    .select('*')
    .eq('id', captureId)
    .single();
  if (error || !data) throw new Error(`Durum alınamadı: ${error?.message ?? 'bulunamadı'}`);

  // splat_path points at the tour's meta.json in the public tours bucket;
  // ply_path at the private archive copy, which may be absent.
  const splatUrl = tourUrl(data.splat_path);
  const plyUrl = await signedUrl(data.ply_path);

  return {
    capture_id: captureId,
    status: (data.status ?? 'unknown') as CaptureStatusValue,
    progress: data.progress ?? 0,
    stage_detail: data.detail ?? '',
    output_splat_url: splatUrl,
    output_ply_url: plyUrl,
    created_at: data.created_at ?? '',
    updated_at: data.updated_at ?? '',
  };
}

export async function deleteCapture(captureId: string): Promise<void> {
  const { error } = await supabase.from('captures').delete().eq('id', captureId);
  if (error) throw new Error(`Silinemedi: ${error.message}`);
}

export async function getViewerUrl(captureId: string): Promise<string> {
  const detail = await getCaptureStatus(captureId);
  if (!detail.output_splat_url) {
    throw new Error('Splat henüz hazır değil');
  }
  return `${VIEWER_URL}?splat=${encodeURIComponent(detail.output_splat_url)}`;
}
