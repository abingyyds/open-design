export type PlatformAccount = {
  configured: boolean;
  defaultModel: string;
  siteName: string;
  accountType: 'site' | 'platform' | string;
};

export type PlatformUser = {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  account?: PlatformAccount;
};

export type PlatformModel = {
  id: string;
  name?: string;
  label?: string;
  description?: string;
};

export type PlatformStatus = {
  enabled: boolean;
  authenticated: boolean;
  user: PlatformUser | null;
};

export type PlatformModelsResponse = {
  models: PlatformModel[];
  defaultModel: string;
};

export type PlatformLoginResponse = PlatformModelsResponse & {
  user: PlatformUser;
};

function platformErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, any>;
    const message = record.error?.message ?? record.message ?? record.error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(platformErrorMessage(payload, fallback));
  return payload as T;
}

export async function fetchPlatformStatus(): Promise<PlatformStatus> {
  const response = await fetch('/api/platform/status', {
    cache: 'no-store',
    credentials: 'include',
  });
  if (response.status === 404) {
    return { enabled: false, authenticated: false, user: null };
  }
  return readJsonResponse<PlatformStatus>(response, '平台状态读取失败');
}

export async function fetchPlatformModels(): Promise<PlatformModelsResponse> {
  const response = await fetch('/api/platform/models', {
    cache: 'no-store',
    credentials: 'include',
  });
  return readJsonResponse<PlatformModelsResponse>(response, '模型列表读取失败');
}

export async function loginPlatform(username: string, password: string): Promise<PlatformLoginResponse> {
  const response = await fetch('/api/platform/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  return readJsonResponse<PlatformLoginResponse>(response, '登录失败');
}

export async function logoutPlatform(): Promise<void> {
  await fetch('/api/platform/logout', {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
}

export async function setPlatformModel(model: string): Promise<{ ok: true; defaultModel: string }> {
  const response = await fetch('/api/platform/model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ model }),
  });
  return readJsonResponse<{ ok: true; defaultModel: string }>(response, '模型保存失败');
}
