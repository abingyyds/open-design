import {
  HOSTED_PREVIEW_NAVIGATION_PARAM,
  HOSTED_PREVIEW_NAVIGATION_PATTERN,
  HOSTED_PREVIEW_RENEW_MESSAGE,
  HOSTED_PREVIEW_RETRY_MESSAGE,
  HOSTED_PREVIEW_SCOPE_PATTERN,
  HOSTED_PREVIEW_VERIFY_RETRY_PATH,
  type HostedPreviewRenewRequest,
  type HostedPreviewVerifyRetryRequest,
  type HostedPreviewVerifyRetryResponse,
} from '@open-design/contracts';

const scopedPreview = /^\/api\/hosted-preview\/([A-Za-z0-9_-]{32})\//u;
const previewEntry = /^\/api\/(?:projects|design-systems)\/[^/]+\/preview-files\//u;
const renewInterval = 3 * 60 * 1000;
const retryDelays = [1000, 2000, 4000];

interface PreviewRetryState {
  src: string;
  attempts: number;
  pending: boolean;
  timer?: number;
}

export function isHostedPreviewEntry(src: string): boolean {
  return previewEntry.test(src);
}

export function newHostedPreviewNavigation(src: string): string {
  const url = new URL(src, window.location.origin);
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  const navigation = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  url.searchParams.set(HOSTED_PREVIEW_NAVIGATION_PARAM, `${Date.now()}.${navigation}`);
  return url.pathname + url.search + url.hash;
}

function renew(scope: string, signal: AbortSignal, entry?: string) {
  const body: HostedPreviewRenewRequest = { entry };
  return fetch(`/api/hosted-preview/${scope}/renew`, {
    method: 'POST', signal, redirect: 'error',
    ...(entry ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

export function keepInlinePreviewAlive(url: string, reopen: () => void): (() => void) | undefined {
  const scope = scopedPreview.exec(url)?.[1];
  if (!scope) return;
  const controller = new AbortController();
  let pending = false;
  const check = async () => {
    if (document.hidden || pending) return;
    pending = true;
    try {
      const response = await renew(scope, controller.signal);
      if (!controller.signal.aborted && response.status === 404) {
        reopen();
      }
    } catch {
      // A transient network failure is retried on the next visible check.
    } finally {
      pending = false;
    }
  };
  const interval = window.setInterval(check, renewInterval);
  document.addEventListener('visibilitychange', check);
  return () => {
    controller.abort();
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', check);
  };
}

export function keepFramedPreviewsAlive(): () => void {
  const controller = new AbortController();
  const lastRenewal = new WeakMap<HTMLIFrameElement, { src: string; at: number; pending: boolean }>();
  const retries = new WeakMap<HTMLIFrameElement, PreviewRetryState>();
  const retryTimers = new Set<number>();

  function retryPreview(frame: HTMLIFrameElement, src: string, url: URL, receipt: string, manual: boolean) {
    const previous = retries.get(frame);
    if (previous?.src === src && previous.pending) return;
    if (previous?.timer !== undefined) {
      window.clearTimeout(previous.timer);
      retryTimers.delete(previous.timer);
    }
    const state: PreviewRetryState = previous?.src === src ? previous : { src, attempts: 0, pending: false };
    const delay = manual ? 250 : retryDelays[state.attempts];
    if (delay === undefined) return;
    state.pending = true;
    retries.set(frame, state);
    const source = frame.contentWindow;
    const isCurrent = () => !controller.signal.aborted && frame.isConnected
      && frame.getAttribute('src') === src && frame.contentWindow === source && retries.get(frame) === state;
    const timer = window.setTimeout(async () => {
      retryTimers.delete(timer);
      state.timer = undefined;
      try {
        if (!source || !isCurrent()) return;
        const entry = url.pathname + url.search;
        const body: HostedPreviewVerifyRetryRequest = { receipt, entry };
        const result = await fetch(HOSTED_PREVIEW_VERIFY_RETRY_PATH, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
        });
        if (!result.ok || !isCurrent()) return;
        const { scope } = await result.json() as Partial<HostedPreviewVerifyRetryResponse>;
        if (!isCurrent() || (scope !== null && (typeof scope !== 'string' || !HOSTED_PREVIEW_SCOPE_PATTERN.test(scope)))) return;
        state.attempts = manual ? 1 : state.attempts + 1;
        // A verified pre-issue 429 can retry the entry. An issued scope keeps its lease and counters.
        const target = scope === null ? src : `/api/hosted-preview/${scope}/?${new URLSearchParams({ entry })}${url.hash}`;
        source.location.replace(target);
      } catch {
        // A failed receipt check does not navigate the preview.
      } finally {
        state.pending = false;
      }
    }, delay + Math.floor(Math.random() * 250));
    state.timer = timer;
    retryTimers.add(timer);
  }

  const onMessage = async (event: MessageEvent) => {
    const { type, scope, receipt, manual } = event.data ?? {};
    if (event.origin !== 'null' || !event.source
      || (type !== HOSTED_PREVIEW_RENEW_MESSAGE && type !== HOSTED_PREVIEW_RETRY_MESSAGE)) return;
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[sandbox]')).find(
      (candidate) => candidate.contentWindow === event.source,
    );
    const src = frame?.getAttribute('src');
    if (!frame || !src || !isHostedPreviewEntry(src)) return;
    const url = new URL(src, window.location.origin);
    const navigation = url.searchParams.get(HOSTED_PREVIEW_NAVIGATION_PARAM);
    if (!HOSTED_PREVIEW_NAVIGATION_PATTERN.test(navigation ?? '')) return;
    if (type === HOSTED_PREVIEW_RETRY_MESSAGE) {
      if (typeof receipt === 'string' && HOSTED_PREVIEW_SCOPE_PATTERN.test(receipt)) {
        retryPreview(frame, src, url, receipt, manual === true);
      }
      return;
    }
    if (typeof scope !== 'string' || !HOSTED_PREVIEW_SCOPE_PATTERN.test(scope)) return;
    const prior = lastRenewal.get(frame);
    const now = Date.now();
    if (prior?.src === src && (prior.pending || now - prior.at < 60_000)) return;
    const attempt = { src, at: now, pending: true };
    lastRenewal.set(frame, attempt);
    try {
      const response = await renew(scope, controller.signal, url.pathname + url.search);
      if (!controller.signal.aborted && response.status === 410 && frame.isConnected
        && frame.getAttribute('src') === src && frame.contentWindow === event.source) {
        frame.src = newHostedPreviewNavigation(src);
      }
    } catch {
      // The framed document will ask again while visible.
    } finally {
      attempt.pending = false;
    }
  };
  window.addEventListener('message', onMessage);
  return () => {
    controller.abort();
    for (const timer of retryTimers) window.clearTimeout(timer);
    window.removeEventListener('message', onMessage);
  };
}
