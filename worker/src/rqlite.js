function basicAuth(username, password) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function buildStatement(sql, params = []) {
  return [sql, ...params];
}

async function postRqlite(env, endpoint, payload) {
  const url = `${String(env.RQLITE_URL || '').replace(/\/$/, '')}${endpoint}`;
  if (!env.RQLITE_URL) throw new Error('Missing RQLITE_URL');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(env.NGINX_USER || '', env.NGINX_PASSWORD || ''),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`rqlite request failed (${res.status})`);
  const body = await res.json();
  return body;
}

function parseRqliteResult(body) {
  const result = body?.results?.[0] || {};
  if (result.error) throw new Error(result.error);
  return result;
}

export async function query(env, sql, params = []) {
  const body = await postRqlite(env, '/db/query', [buildStatement(sql, params)]);
  const result = parseRqliteResult(body);
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const values = Array.isArray(result.values) ? result.values : [];
  return values.map((row) => {
    const out = {};
    for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
    return out;
  });
}

export async function execute(env, sql, params = []) {
  const body = await postRqlite(env, '/db/execute', [buildStatement(sql, params)]);
  return parseRqliteResult(body);
}

export async function executeBatch(env, statements) {
  const payload = statements.map(({ sql, params = [] }) => buildStatement(sql, params));
  const body = await postRqlite(env, '/db/execute', payload);
  const results = Array.isArray(body?.results) ? body.results : [];
  for (const result of results) {
    if (result?.error) throw new Error(result.error);
  }
  return results;
}
