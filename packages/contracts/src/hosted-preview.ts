export const HOSTED_PREVIEW_SANDBOX = 'allow-scripts';
export const HOSTED_PREVIEW_RENEW_MESSAGE = 'od:hosted-preview-renew';
export const HOSTED_PREVIEW_RETRY_MESSAGE = 'od:hosted-preview-retry';
export const HOSTED_PREVIEW_VERIFY_RETRY_PATH = '/api/hosted-preview/verify-retry';
export const HOSTED_PREVIEW_SCOPE_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
export const HOSTED_PREVIEW_NAVIGATION_PARAM = 'odPreviewNavigation';
export const HOSTED_PREVIEW_NAVIGATION_PATTERN = /^(\d{13})\.[a-f0-9]{32}$/u;

export interface HostedPreviewVerifyRetryRequest {
  receipt: string;
  entry: string;
}

export interface HostedPreviewVerifyRetryResponse {
  scope: string | null;
}

export interface HostedPreviewRenewRequest {
  entry?: string;
}

export const HOSTED_PREVIEW_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
].join('; ');

export const HOSTED_PREVIEW_DOCUMENT_POLICY = [
  `sandbox ${HOSTED_PREVIEW_SANDBOX}`,
  HOSTED_PREVIEW_CONTENT_POLICY,
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join('; ');
