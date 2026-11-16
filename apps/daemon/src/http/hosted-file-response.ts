import type { ServerResponse } from 'node:http';
import { HOSTED_PREVIEW_DOCUMENT_POLICY } from '@open-design/contracts';

const activeDocumentMime = /^(?:text\/(?:html|xml)|application\/(?:xhtml\+xml|xml)|image\/svg\+xml)(?:;|$)/iu;

/** Raw tenant file responses use an inert document origin. */
export function setHostedDownloadHeaders(res: ServerResponse, mime: string): void {
  setHostedDocumentHeaders(res);

  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (activeDocumentMime.test(mime)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
}

/** Executable previews have an opaque origin even when opened directly. */
export function setHostedPreviewHeaders(res: ServerResponse): void {
  setHostedDocumentHeaders(res);
  res.setHeader('Content-Security-Policy', HOSTED_PREVIEW_DOCUMENT_POLICY);
}

function setHostedDocumentHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
