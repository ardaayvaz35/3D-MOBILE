import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getCaptureStatus } from './captures';

/**
 * Downloads the trained .ply for a capture and hands it to the native share
 * sheet (AirDrop / Save to Files / etc.) so the user can move it to a
 * computer and open it in an external tool like SuperSplat -- mirrors
 * Polycam's "Export -> Splat PLY -> open in SuperSplat" flow.
 */
export async function downloadAndShareSplat(
  captureId: string,
  onProgress?: (status: string) => void
): Promise<void> {
  onProgress?.('Durum kontrol ediliyor...');
  const detail = await getCaptureStatus(captureId);
  const url = detail.output_ply_url;
  if (!url) {
    throw new Error('.ply dosyası henüz hazır değil.');
  }

  const fileName = `scan_${captureId.slice(0, 8)}.ply`;
  const dest = new File(Paths.cache, fileName);
  if (dest.exists) dest.delete();

  onProgress?.('İndiriliyor...');
  const file = await File.downloadFileAsync(url, dest);

  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Bu cihazda paylaşım desteklenmiyor.');
  }

  onProgress?.('Paylaşım açılıyor...');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/octet-stream',
    dialogTitle: 'Splat (.ply) dosyasını paylaş',
    UTI: 'public.data',
  });
}
