// Supabase-native capture API (no FastAPI backend).
//
// Flow:
//   1. Upload the raw archive straight to Supabase Storage (`capture-uploads`)
//      under the user's own {user_id}/{capture_id}/ prefix, using the user's
//      session (RLS-scoped).
//   2. Call the `submit-capture` Edge Function, which holds the RunPod secret,
//      charges credits, creates the captures row, and triggers the GPU.
//   3. Read status + list directly from the `captures` table via RLS, and mint
//      signed URLs for our own splats client-side.

import * as FileSystem from 'expo-file-system/legacy';
import { CaptureDetail, CaptureStatusValue, ClientType, UploadResponse } from '../types/capture';
import { supabase } from '../lib/supabase';

const UPLOAD_BUCKET = 'capture-uploads';
const SPLATS_BUCKET = 'splats';
const SIGNED_URL_TTL = 3600;

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

export async function uploadCapture(
  archive: LocalArchive,
  clientType: ClientType
): Promise<UploadResponse> {
  const userId = await requireUserId();

  const ext = /\.(tar\.gz|tgz)$/i.test(archive.name) ? '.tar.gz' : '.zip';
  // A temp folder under the user's prefix; the authoritative capture id is
  // minted by the Edge Function. Keeping the archive under the user's prefix
  // is what RLS + the function's ownership check rely on.
  const folder = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const storagePath = `${folder}/frames${ext}`;

  // Stream the archive straight from disk to Storage. Reading a large scan
  // zip into a JS string/ArrayBuffer blows past the engine's string-length
  // limit ("string length exceeds limit"), so we get a signed upload URL and
  // PUT the file with expo-file-system, which streams from disk without ever
  // materializing the whole file in JS memory.
  const info = await FileSystem.getInfoAsync(archive.uri);
  console.log('[upload] archive', archive.uri, 'exists:', info.exists, 'size:', (info as any).size);

  console.log('[upload] requesting signed url for', storagePath);
  const { data: signed, error: signErr } = await supabase.storage
    .from(UPLOAD_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (signErr || !signed?.signedUrl) {
    console.log('[upload] signed url FAILED', signErr);
    throw new Error(`Yükleme URL'si alınamadı: ${signErr?.message ?? 'bilinmeyen hata'}`);
  }
  console.log('[upload] got signed url, streaming file...');

  const uploadRes = await FileSystem.uploadAsync(signed.signedUrl, archive.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': archive.mimeType },
  });
  console.log('[upload] upload HTTP status:', uploadRes.status);
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(
      `Yükleme başarısız (HTTP ${uploadRes.status}): ${uploadRes.body?.slice(0, 200) ?? ''}`
    );
  }
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

  const [splatUrl, plyUrl] = await Promise.all([
    signedUrl(data.splat_path),
    signedUrl(data.ply_path ?? data.splat_path),
  ]);

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
