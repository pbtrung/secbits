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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Vault-Bucket, X-Vault-Prefix, X-Vault-Id, X-Vault-File',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'X-Vault-Size, X-Vault-Etag, X-Vault-Uploaded',
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

async function requireAuthAndLimit(request, env) {
  const token = await requireAuth(request, env);
  const { success } = await env.RATE_LIMITER.limit({ key: token.sub });
  if (!success) throw new HttpError(429, 'Rate limit exceeded');
  return token;
}

function resolveReadConfig(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON body');
  const bucket_name = sanitizePathPart(body.bucket_name, 'bucket_name');
  const prefix = sanitizePathPart(body.prefix, 'prefix');
  const vault_id = sanitizePathPart(body.vault_id, 'vault_id');
  const file_name = sanitizePathPart(body.file_name, 'file_name');
  return { bucket_name, prefix, vault_id, file_name };
}

function resolveWriteHeaders(request) {
  const bucket_name = sanitizePathPart(request.headers.get('X-Vault-Bucket'), 'X-Vault-Bucket');
  const prefix = sanitizePathPart(request.headers.get('X-Vault-Prefix'), 'X-Vault-Prefix');
  const vault_id = sanitizePathPart(request.headers.get('X-Vault-Id'), 'X-Vault-Id');
  const file_name = sanitizePathPart(request.headers.get('X-Vault-File'), 'X-Vault-File');
  return { bucket_name, prefix, vault_id, file_name };
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
        await requireAuthAndLimit(request, env);
        const body = await request.json().catch(() => null);
        const { bucket_name, prefix, vault_id, file_name } = resolveReadConfig(body);
        const key = resolveKey(bucket_name, prefix, vault_id, file_name, env);

        const object = await env.SECBITS_R2.get(key);
        if (!object) {
          return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        return new Response(object.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Vault-Size': String(object.size),
            'X-Vault-Etag': object.httpEtag,
            'X-Vault-Uploaded': object.uploaded?.toISOString() ?? '',
            ...corsHeaders(origin),
          },
        });
      }

      if (url.pathname === '/vault/write' && request.method === 'POST') {
        await requireAuthAndLimit(request, env);
        const { bucket_name, prefix, vault_id, file_name } = resolveWriteHeaders(request);
        const key = resolveKey(bucket_name, prefix, vault_id, file_name, env);

        const bytes = await request.arrayBuffer();
        if (!bytes.byteLength) throw new HttpError(400, 'Empty payload');

        await env.SECBITS_R2.put(key, bytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });

        return json({ ok: true, size: bytes.byteLength }, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return json({ error: err?.message || 'Unexpected error' }, status, origin);
    }
  },
};
