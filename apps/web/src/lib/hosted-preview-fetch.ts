const retryDelays = [250, 500, 1000];

export async function fetchHostedPreview(url: string, init: RequestInit = {}): Promise<Response> {
  for (const delay of retryDelays) {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    await response.body?.cancel();
    await waitForRetry(delay, init.signal);
  }
  return fetch(url, init);
}

function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
