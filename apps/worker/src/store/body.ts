// A request handed to a Durable Object streams its body in from the Worker. When the object answers without reading
// it (a route that takes no body, or a refusal before the body is read), the runtime is still sending it after the
// answer went out, and logs "Can't read from request stream after response has been sent". Discarding what the
// answer didn't read, before the answer is returned, ends the stream cleanly.

/** Reads the rest of the request's body if nothing read it. Safe on a request with no body or a read one. */
export async function settleBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  await request.arrayBuffer().catch(() => undefined);
}

/** Runs a handler, then discards whatever of the request's body it left unread. */
export async function answering(
  request: Request,
  handle: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await handle();
  } finally {
    await settleBody(request);
  }
}
