import { describe, expect, it } from 'vitest';
import {
  JSON_RPC_ERROR_CODES,
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcLine,
} from '../../src/rpc/json-rpc-line-protocol';

describe('JSON-RPC line protocol', () => {
  it('parses one request from one JSON line', () => {
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":7,"method":"system.ping","params":{}}')).toEqual(
      {
        ok: true,
        message: { jsonrpc: '2.0', id: 7, method: 'system.ping', params: {} },
      },
    );
  });

  it('returns parse error for malformed JSON', () => {
    expect(parseJsonRpcLine('{')).toEqual({
      ok: false,
      response: createErrorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
    });
  });

  it('rejects invalid requests and batch arrays', () => {
    for (const line of ['{"jsonrpc":"1.0","id":1,"method":"ping"}', '[]']) {
      expect(parseJsonRpcLine(line)).toEqual({
        ok: false,
        response: createErrorResponse(
          null,
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request',
        ),
      });
    }
  });

  it('builds JSON-RPC success and error responses', () => {
    expect(createSuccessResponse('request-1', { status: 'ok' })).toEqual({
      jsonrpc: '2.0',
      id: 'request-1',
      result: { status: 'ok' },
    });
    expect(createErrorResponse(2, -32004, 'Run not found', { run_id: 'missing' })).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32004, message: 'Run not found', data: { run_id: 'missing' } },
    });
  });
});
