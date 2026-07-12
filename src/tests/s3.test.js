import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('aws4fetch', () => ({
  // Must be a real constructor (not an arrow function) since s3.js calls
  // `new AwsClient(...)`.
  AwsClient: vi.fn().mockImplementation(function AwsClient() {
    return { fetch: fetchMock };
  }),
}));

const { uploadAllBackupDestinations } = await import('../lib/s3.js');

function okResponse() {
  return { ok: true };
}

function failResponse(status, text) {
  return { ok: false, status, text: async () => text };
}

describe('uploadAllBackupDestinations', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('uploads to R2 and every s3_config destination independently, one failure does not block the others', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.includes('bad-bucket')) return failResponse(403, 'Forbidden');
      return okResponse();
    });

    const results = await uploadAllBackupDestinations(
      {
        r2_config: { account_id: 'acct', bucket: 'good-bucket', access_key_id: 'k', secret_access_key: 's' },
        s3_config: [
          {
            endpoint: 'https://s3.us-west-1.amazonaws.com',
            region: 'us-west-1',
            bucket: 'good-bucket',
            access_key_id: 'k',
            secret_access_key: 's',
          },
          {
            endpoint: 'https://s3.us-west-1.amazonaws.com',
            region: 'us-west-1',
            bucket: 'bad-bucket',
            access_key_id: 'k',
            secret_access_key: 's',
          },
        ],
      },
      new Uint8Array([1, 2, 3]),
      'backup.bin',
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ destination: 'r2', ok: true });
    expect(results[1]).toEqual({ destination: 's3[0] https://s3.us-west-1.amazonaws.com', ok: true });
    expect(results[2].ok).toBe(false);
    expect(results[2].destination).toBe('s3[1] https://s3.us-west-1.amazonaws.com');
    expect(results[2].error).toContain('403');
    expect(results[2].error).toContain('Forbidden');
  });

  it('returns an empty result set when no destinations are configured', async () => {
    const results = await uploadAllBackupDestinations({ r2_config: null, s3_config: [] }, new Uint8Array(), 'k');
    expect(results).toEqual([]);
  });

  it('reports a failing R2 upload without throwing', async () => {
    fetchMock.mockResolvedValue(failResponse(500, 'Internal Server Error'));

    const results = await uploadAllBackupDestinations(
      { r2_config: { account_id: 'acct', bucket: 'b', access_key_id: 'k', secret_access_key: 's' }, s3_config: [] },
      new Uint8Array(),
      'backup.bin',
    );

    expect(results).toEqual([{ destination: 'r2', ok: false, error: expect.stringContaining('500') }]);
  });
});
