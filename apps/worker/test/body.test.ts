// A Durable Object discards the request body its answer didn't read (store/body.ts), so the runtime doesn't log
// "Can't read from request stream after response has been sent" for routes that take no body.
import { describe, expect, it } from 'vitest';
import { answering } from '../src/store/body.js';

const post = (body?: string) => new Request('https://x.test/', { method: 'POST', body });

describe('answering', () => {
  it('reads a body the handler left unread, before the answer is returned', async () => {
    const req = post('{}');
    const res = await answering(req, () => {
      expect(req.bodyUsed).toBe(false);
      return new Response('ok');
    });
    expect(await res.text()).toBe('ok');
    expect(req.bodyUsed).toBe(true);
  });

  it('leaves a body the handler read, and a request with none', async () => {
    const read = post('{"a":1}');
    await answering(read, async () => Response.json(await read.json()));
    expect(read.bodyUsed).toBe(true);
    const none = post();
    await answering(none, () => new Response(null, { status: 204 }));
    expect(none.bodyUsed).toBe(false);
  });

  it('still reads the body when the handler throws', async () => {
    const req = post('{}');
    await expect(
      answering(req, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(req.bodyUsed).toBe(true);
  });
});
