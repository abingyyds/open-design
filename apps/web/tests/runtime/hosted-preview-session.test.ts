// @vitest-environment jsdom

import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_PREVIEW_RENEW_MESSAGE, HOSTED_PREVIEW_RETRY_MESSAGE, HOSTED_PREVIEW_VERIFY_RETRY_PATH } from '@open-design/contracts';
import { keepFramedPreviewsAlive, newHostedPreviewNavigation } from '../../src/runtime/hosted-preview-session';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('hosted framed previews', () => {
  it.each([404, 410])('reopens only when the daemon recognizes the expired framed scope (%s)', async (status) => {
    const cleanup = keepFramedPreviewsAlive();
    try {
      const frame = document.createElement('iframe');
      const path = '/api/design-systems/user%3Afixture/preview-files/demo.html?v=1';
      const entry = newHostedPreviewNavigation(path);
      const scope = 'a'.repeat(32);
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('src', entry);
      document.body.append(frame);
      const reload = vi.spyOn(frame, 'src', 'set').mockImplementation(() => {});
      const renew = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal('fetch', renew);
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null', source: frame.contentWindow,
        data: { type: HOSTED_PREVIEW_RENEW_MESSAGE, scope },
      }));
      if (status === 410) {
        await waitFor(() => expect(reload).toHaveBeenCalledOnce());
        expect(reload.mock.calls[0]?.[0]).toContain(`${path}&odPreviewNavigation=`);
        expect(reload.mock.calls[0]?.[0]).not.toBe(entry);
      } else {
        await Promise.resolve();
        expect(reload).not.toHaveBeenCalled();
      }
      expect(renew).toHaveBeenCalledWith(`/api/hosted-preview/${scope}/renew`, expect.objectContaining({
        method: 'POST', body: JSON.stringify({ entry }),
      }));
    } finally {
      cleanup();
    }
  });

  it('cancels scheduled retry verification when the parent changes the framed navigation', async () => {
    vi.useFakeTimers();
    const cleanup = keepFramedPreviewsAlive();
    try {
      const frame = document.createElement('iframe');
      const path = '/api/projects/fixture/preview-files/index.html';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('src', newHostedPreviewNavigation(path));
      document.body.append(frame);
      const verify = vi.fn();
      vi.stubGlobal('fetch', verify);
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null', source: frame.contentWindow,
        data: { type: HOSTED_PREVIEW_RETRY_MESSAGE, receipt: 'a'.repeat(32) },
      }));
      frame.setAttribute('src', newHostedPreviewNavigation(path));
      await vi.advanceTimersByTimeAsync(1500);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each([200, 404])('navigates only when same-origin receipt verification succeeds (%s)', async (status) => {
    vi.useFakeTimers();
    const cleanup = keepFramedPreviewsAlive();
    try {
      const frame = document.createElement('iframe');
      const entry = newHostedPreviewNavigation('/api/projects/fixture/preview-files/index.html');
      const receipt = 'a'.repeat(32);
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('src', entry);
      document.body.append(frame);
      const replace = vi.fn();
      const source = { location: { replace } } as unknown as Window;
      vi.spyOn(frame, 'contentWindow', 'get').mockReturnValue(source);
      const verify = vi.fn(async () => Response.json({ scope: null }, { status }));
      vi.stubGlobal('fetch', verify);
      const message = new MessageEvent('message', {
        origin: 'null', data: { type: HOSTED_PREVIEW_RETRY_MESSAGE, receipt, manual: false },
      });
      Object.defineProperty(message, 'source', { value: source });
      window.dispatchEvent(message);
      await vi.advanceTimersByTimeAsync(1500);
      expect(verify).toHaveBeenCalledExactlyOnceWith(HOSTED_PREVIEW_VERIFY_RETRY_PATH, expect.objectContaining({
        method: 'POST', body: JSON.stringify({ receipt, entry }),
      }));
      if (status === 200) expect(replace).toHaveBeenCalledExactlyOnceWith(entry);
      else expect(replace).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('discards a renewal response once the parent has navigated to a new preview', async () => {
    const cleanup = keepFramedPreviewsAlive();
    try {
      const frame = document.createElement('iframe');
      const entry = '/api/projects/fixture/preview-files/index.html';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('src', newHostedPreviewNavigation(entry));
      document.body.append(frame);
      const reopened = vi.spyOn(frame, 'src', 'set').mockImplementation(() => {});
      let finish!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => { finish = resolve; });
      const renew = vi.fn(() => response);
      vi.stubGlobal('fetch', renew);
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null', source: frame.contentWindow,
        data: { type: HOSTED_PREVIEW_RENEW_MESSAGE, scope: 'a'.repeat(32) },
      }));
      expect(renew).toHaveBeenCalledOnce();
      frame.setAttribute('src', newHostedPreviewNavigation(entry));
      finish(new Response(null, { status: 410 }));
      await response;
      expect(reopened).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
