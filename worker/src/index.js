import { verifyFirebaseToken } from './firebase';

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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
  if (!out) throw new Error(`Missing required field: ${field}`);
  if (out.includes('..') || out.includes('\\')) throw new Error(`Invalid value for ${field}`);
  return out;
}

function normalizePrefix(prefixRaw) {
  const prefix = String(prefixRaw || '').trim();
  if (!prefix) return '';
  if (prefix.includes('..') || prefix.includes('\\')) throw new Error('Invalid value for prefix');
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function resolveKey(bucketName, prefix, fileName, env) {
  if (!env.R2_BUCKET_NAME) {
    throw new Error('Worker env R2_BUCKET_NAME is not configured');
  }
  if (bucketName !== env.R2_BUCKET_NAME) {
    throw new Error(`Configured bucket_name does not match worker bucket (${env.R2_BUCKET_NAME})`);
  }
  return `${prefix}${fileName}`;
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Missing bearer token');
  return verifyFirebaseToken(match[1], env.FIREBASE_PROJECT_ID);
}

function resolveReadConfig(url) {
  const bucket_name = sanitizePathPart(url.searchParams.get('bucket_name'), 'bucket_name');
  const prefix = normalizePrefix(url.searchParams.get('prefix'));
  const file_name = sanitizePathPart(url.searchParams.get('file_name'), 'file_name');
  return { bucket_name, prefix, file_name };
}

async function resolveWriteConfig(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('Invalid JSON body');
  const r2 = body.r2;
  if (!r2 || typeof r2 !== 'object') throw new Error('Missing required field: r2');

  const bucket_name = sanitizePathPart(r2.bucket_name, 'r2.bucket_name');
  const prefix = normalizePrefix(r2.prefix);
  const file_name = sanitizePathPart(r2.file_name, 'r2.file_name');
  const payload_b64 = sanitizePathPart(body.payload_b64, 'payload_b64');

  let bytes;
  try {
    const bin = atob(payload_b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new Error('Invalid payload_b64');
  }

  return {
    bucket_name,
    prefix,
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

      if (url.pathname === '/vault' && request.method === 'GET') {
        await requireAuth(request, env);
        const { bucket_name, prefix, file_name } = resolveReadConfig(url);
        const key = resolveKey(bucket_name, prefix, file_name, env);

        const object = await env.SECBITS_R2.get(key);
        if (!object) return json({ error: 'Not found' }, 404, origin);

        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const payload_b64 = btoa(binary);

        return json({
          payload_b64,
          key,
          size: object.size,
          etag: object.httpEtag,
          uploaded: object.uploaded,
        }, 200, origin);
      }

      if (url.pathname === '/vault' && request.method === 'PUT') {
        await requireAuth(request, env);
        const config = await resolveWriteConfig(request);
        const key = resolveKey(config.bucket_name, config.prefix, config.file_name, env);

        await env.SECBITS_R2.put(key, config.bytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });

        return json({ ok: true, key, size: config.bytes.length }, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);
    } catch (err) {
      return json({ error: err?.message || 'Unexpected error' }, 400, origin);
    }
  },
};
