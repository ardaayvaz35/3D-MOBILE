import { getBackendUrl } from '../config/backendConfig';
import { CaptureDetail, CaptureStatusValue, ClientType, UploadResponse } from '../types/capture';
import { supabase } from '../lib/supabase';

export type LocalArchive = {
  uri: string;
  name: string;
  mimeType: string;
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  return {
    Authorization: `Bearer ${session.access_token}`,
    Accept: 'application/json',
  };
}

export async function uploadCapture(
  archive: LocalArchive,
  clientType: ClientType
): Promise<UploadResponse> {
  const backendUrl = await getBackendUrl();
  const headers = await getAuthHeaders();

  const formData = new FormData();
  formData.append('file', {
    uri: archive.uri,
    name: archive.name,
    type: archive.mimeType,
  } as unknown as Blob);
  formData.append('client_type', clientType);

  const response = await fetch(`${backendUrl}/api/captures/upload`, {
    method: 'POST',
    body: formData,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload başarısız (${response.status}): ${text}`);
  }

  return response.json();
}

export type CaptureListItem = {
  id: string;
  status: CaptureStatusValue;
  client_type: ClientType;
  created_at: string;
};

export async function listCaptures(): Promise<CaptureListItem[]> {
  const backendUrl = await getBackendUrl();
  const headers = await getAuthHeaders();
  const response = await fetch(`${backendUrl}/api/captures`, { headers });
  if (!response.ok) {
    throw new Error(`Taramalar alınamadı (${response.status})`);
  }
  return response.json();
}

export async function getCaptureStatus(captureId: string): Promise<CaptureDetail> {
  const backendUrl = await getBackendUrl();
  const headers = await getAuthHeaders();
  const response = await fetch(`${backendUrl}/api/captures/${captureId}`, { headers });
  if (!response.ok) {
    throw new Error(`Durum alınamadı (${response.status})`);
  }
  return response.json();
}

export async function getViewerUrl(captureId: string): Promise<string> {
  const backendUrl = await getBackendUrl();
  const detail = await getCaptureStatus(captureId);
  if (!detail.output_splat_url) {
    throw new Error('Splat henüz hazır değil');
  }
  return `${backendUrl}/viewer/index.html?splat=${encodeURIComponent(detail.output_splat_url)}`;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/health`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}
