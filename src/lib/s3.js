import { AwsClient } from 'aws4fetch';

async function putObject({ endpoint, region, bucket, accessKeyId, secretAccessKey }, key, bodyBytes) {
  const client = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}/${encodeURIComponent(key)}`;
  const res = await client.fetch(url, {
    method: 'PUT',
    body: bodyBytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function uploadToR2(r2Config, key, bodyBytes) {
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

async function uploadToS3(s3DestinationConfig, key, bodyBytes) {
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

// Every destination is uploaded and reported independently: a failure at one
// must never block or roll back the others (see docs/crypto.md, Cloud
// Backup and docs/testing.md).
export async function uploadAllBackupDestinations({ r2_config, s3_config }, bodyBytes, key) {
  const results = [];

  if (r2_config) {
    try {
      await uploadToR2(r2_config, key, bodyBytes);
      results.push({ destination: 'r2', ok: true });
    } catch (err) {
      results.push({ destination: 'r2', ok: false, error: err?.message || String(err) });
    }
  }

  for (const [i, s3Dest] of (s3_config || []).entries()) {
    const label = `s3[${i}] ${s3Dest.endpoint || ''}`;
    try {
      await uploadToS3(s3Dest, key, bodyBytes);
      results.push({ destination: label, ok: true });
    } catch (err) {
      results.push({ destination: label, ok: false, error: err?.message || String(err) });
    }
  }

  return results;
}
