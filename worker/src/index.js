import { verifyFirebaseToken } from './firebase';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function sanitizePathPart(value, field) {
  const out = String(value || '').trim();
  if (!out) throw new HttpError(400, `Missing required field: ${field}`);
  if (out.includes('..') || out.includes('\\')) throw new HttpError(400, `Invalid value for ${field}`);
  return out;
}

function resolveKey(bucketName, prefix, vaultId, fileName, env) {
  if (!env.R2_BUCKET_NAME) {
    throw new HttpError(500, 'Worker env R2_BUCKET_NAME is not configured');
  }
  if (bucketName !== env.R2_BUCKET_NAME) {
    throw new HttpError(400, `Configured bucket_name does not match worker bucket (${env.R2_BUCKET_NAME})`);
  }
  return `${prefix}/${vaultId}/${fileName}`;
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, 'Missing bearer token');
  try {
    return await verifyFirebaseToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch {
    throw new HttpError(401, 'Invalid bearer token');
  }
}

function resolveReadConfig(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON body');
  const bucket_name = sanitizePathPart(body.bucket_name, 'bucket_name');
  const prefix = sanitizePathPart(body.prefix, 'prefix');
  const vault_id = sanitizePathPart(body.vault_id, 'vault_id');
  const file_name = sanitizePathPart(body.file_name, 'file_name');
  return { bucket_name, prefix, vault_id, file_name };
}

function resolveWriteConfig(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON body');

  const bucket_name = sanitizePathPart(body.bucket_name, 'bucket_name');
  const prefix = sanitizePathPart(body.prefix, 'prefix');
  const vault_id = sanitizePathPart(body.vault_id, 'vault_id');
  const file_name = sanitizePathPart(body.file_name, 'file_name');
  const payload_b64 = sanitizePathPart(body.payload_b64, 'payload_b64');

  let bytes;
  try {
    const bin = atob(payload_b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new HttpError(400, 'Invalid payload_b64');
  }

  return {
    bucket_name,
    prefix,
    vault_id,
    file_name,
    payload_b64,
    bytes,
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      const url = new URL(request.url);

      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true }, 200, origin);
      }

      if (url.pathname === '/vault/read' && request.method === 'POST') {
        await requireAuth(request, env);
        const body = await request.json().catch(() => null);
        const { bucket_name, prefix, vault_id, file_name } = resolveReadConfig(body);
        const key = resolveKey(bucket_name, prefix, vault_id, file_name, env);

        const object = await env.SECBITS_R2.get(key);
        if (!object) {
          return json({
            exists: false,
            payload_b64: null,
          }, 200, origin);
        }

        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const payload_b64 = btoa(binary);

        return json({
          exists: true,
          payload_b64,
          size: object.size,
          etag: object.httpEtag,
          uploaded: object.uploaded,
        }, 200, origin);
      }

      if (url.pathname === '/vault/write' && request.method === 'POST') {
        await requireAuth(request, env);
        const body = await request.json().catch(() => null);
        const config = resolveWriteConfig(body);
        const key = resolveKey(config.bucket_name, config.prefix, config.vault_id, config.file_name, env);

        await env.SECBITS_R2.put(key, config.bytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });

        return json({ ok: true, size: config.bytes.length }, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return json({ error: err?.message || 'Unexpected error' }, status, origin);
    }
  },
};
