import { File, Paths } from 'expo-file-system';
import JSZip from 'jszip';

export type ZipEntry = {
  /** file:// URI of the source file */
  uri: string;
  /** name to use inside the archive */
  name: string;
};

/**
 * Zips a list of local files plus a generated metadata.json into a single
 * .zip in the cache directory. Pure JS (JSZip) so it works inside plain
 * Expo Go - no native zip module required.
 */
export async function zipFilesWithMetadata(
  entries: ZipEntry[],
  metadata: unknown,
  zipName: string
): Promise<File> {
  const zip = new JSZip();

  for (const entry of entries) {
    const bytes = await new File(entry.uri).bytes();
    zip.file(entry.name, bytes);
  }

  zip.file('metadata.json', JSON.stringify(metadata, null, 2));

  const zipBytes: Uint8Array = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const zipFile = new File(Paths.cache, zipName);
  if (zipFile.exists) {
    zipFile.delete();
  }
  zipFile.create();
  zipFile.write(zipBytes);

  return zipFile;
}
