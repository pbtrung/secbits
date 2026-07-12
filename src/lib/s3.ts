import { AwsClient } from 'aws4fetch';
import type { BackupDestinations, R2Config, S3DestinationConfig } from '../types';

export interface UploadResult {
  destination: string;
  ok: boolean;
  error?: string;
}

interface Destination {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

async function putObject(
  { endpoint, region, bucket, accessKeyId, secretAccessKey }: Destination,
  key: string,
  bodyBytes: Uint8Array,
): Promise<void> {
  const client = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}/${encodeURIComponent(key)}`;
  const res = await client.fetch(url, {
    method: 'PUT',
    // @types/node's Uint8Array override isn't structurally identical to
    // DOM lib's BodyInit union; Uint8Array is a valid fetch body at
    // runtime regardless, so this is a type-only mismatch.
    body: bodyBytes as BodyInit,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function uploadToR2(r2Config: R2Config, key: string, bodyBytes: Uint8Array): Promise<void> {
  await putObject(
    {
      endpoint: `https://${r2Config.account_id}.r2.cloudflarestorage.com`,
      region: 'auto',
      bucket: r2Config.bucket,
      accessKeyId: r2Config.access_key_id,
      secretAccessKey: r2Config.secret_access_key,
    },
    key,
    bodyBytes,
  );
}

async function uploadToS3(s3DestinationConfig: S3DestinationConfig, key: string, bodyBytes: Uint8Array): Promise<void> {
  await putObject(
    {
      endpoint: s3DestinationConfig.endpoint,
      region: s3DestinationConfig.region,
      bucket: s3DestinationConfig.bucket,
      accessKeyId: s3DestinationConfig.access_key_id,
      secretAccessKey: s3DestinationConfig.secret_access_key,
    },
    key,
    bodyBytes,
  );
}

async function reportUpload(destination: string, uploadFn: () => Promise<void>): Promise<UploadResult> {
  try {
    await uploadFn();
    return { destination, ok: true };
  } catch (err) {
    return { destination, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Every destination is uploaded and reported independently: a failure at one
// must never block or roll back the others (see docs/crypto.md, Cloud
// Backup and docs/testing.md).
export async function uploadAllBackupDestinations(
  { r2_config, s3_config }: BackupDestinations,
  bodyBytes: Uint8Array,
  key: string,
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];

  if (r2_config) {
    results.push(await reportUpload('r2', () => uploadToR2(r2_config, key, bodyBytes)));
  }

  for (const [i, s3Dest] of (s3_config || []).entries()) {
    const label = `s3[${i}] ${s3Dest.endpoint || ''}`;
    results.push(await reportUpload(label, () => uploadToS3(s3Dest, key, bodyBytes)));
  }

  return results;
}
