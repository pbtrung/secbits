import { describe, expect, it, vi } from 'vitest';
import { execute, query } from '../src/rqlite.js';

const ENV = {
  RQLITE_URL: 'http://rqlite.local',
  RQLITE_USERNAME: 'u',
  RQLITE_PASSWORD: 'p',
};

describe('rqlite client', () => {
  it('query posts to /db/query with basic auth and returns rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ columns: ['id', 'blob'], values: [['1', 'YWJj']] }],
      }), { status: 200 }),
    );

    const rows = await query(ENV, 'SELECT id, blob FROM t WHERE id=?', ['1']);
    expect(rows).toEqual([{ id: '1', blob: 'YWJj' }]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://rqlite.local/db/query',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${btoa('u:p')}`,
        }),
      }),
    );
  });

  it('execute posts to /db/execute and throws on rqlite errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ rows_affected: 1 }] }), { status: 200 }),
    );
    await expect(execute(ENV, 'INSERT INTO t VALUES (?)', ['x'])).resolves.toEqual(
      expect.objectContaining({ rows_affected: 1 }),
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ error: 'boom' }] }), { status: 200 }),
    );
    await expect(execute(ENV, 'INSERT INTO t VALUES (?)', ['x'])).rejects.toThrow('boom');
  });

  it('sends parameterized body in [[sql, ...params]] format', async () => {
    let capturedBody;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [{ rows_affected: 1 }] }), { status: 200 });
    });
    await execute(ENV, 'INSERT INTO t VALUES (?, ?)', ['val1', 'val2']);
    expect(Array.isArray(capturedBody)).toBe(true);
    expect(capturedBody[0]).toEqual(['INSERT INTO t VALUES (?, ?)', 'val1', 'val2']);
  });

  it('passes BLOB params as base64 strings unchanged', async () => {
    const blobB64 = btoa(String.fromCharCode(0x01, 0x02, 0x03, 0xff));
    let capturedBody;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [{ rows_affected: 1 }] }), { status: 200 });
    });
    await execute(ENV, 'INSERT INTO t VALUES (?)', [blobB64]);
    expect(capturedBody[0]).toEqual(['INSERT INTO t VALUES (?)', blobB64]);
  });

  it('throws on network failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(query(ENV, 'SELECT 1', [])).rejects.toThrow('offline');
    await expect(execute(ENV, 'DELETE FROM t', [])).rejects.toThrow('offline');
  });
});
