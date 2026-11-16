/** Keep the long-lived key on the daemon side of the task transport. */
export async function sendHostedResponses(
  baseUrl: string,
  apiKey: string,
  model: string,
  fields: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('Hosted model gateway requires HTTPS');
  }
  const body = { ...fields, model, store: false, background: false };
  delete (body as Record<string, unknown>).previous_response_id;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  });
  if (!response.body) return response;

  // An upstream error may echo a credential. Retain a short tail so an echo
  // split across response chunks still gets removed before reaching the task.
  const rawKey = apiKey.replace(/^sk-/i, '');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let tail = '';
  const redact = (text: string) => text
    .replaceAll(apiKey, '[redacted]')
    .replaceAll(rawKey, '[redacted]');
  const safe = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = redact(tail + decoder.decode(chunk, { stream: true }));
      const end = Math.max(0, text.length - apiKey.length + 1);
      tail = text.slice(end);
      if (end > 0) controller.enqueue(encoder.encode(text.slice(0, end)));
    },
    flush(controller) {
      const text = redact(tail + decoder.decode());
      if (text) controller.enqueue(encoder.encode(text));
    },
  }));
  const contentType = response.headers.get('content-type')?.split(';', 1)[0];
  return new Response(safe, {
    status: response.status,
    headers: { 'Content-Type': contentType === 'text/event-stream' ? contentType : 'application/json' },
  });
}
