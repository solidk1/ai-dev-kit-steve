import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeAgent } from './api';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('invokeAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects when the stream endpoint fails after invocation succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          execution_id: 'exec-1',
          conversation_id: 'conv-1',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            detail: 'boom',
          },
          { status: 500 }
        )
      );

    vi.stubGlobal('fetch', fetchMock);

    const onEvent = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();

    await expect(
      invokeAgent({
        projectId: 'project-1',
        conversationId: null,
        message: 'hello',
        onEvent,
        onError,
        onDone,
      })
    ).rejects.toThrow('boom');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(onDone).not.toHaveBeenCalled();
  });
});
