// @ts-nocheck
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';

const DEFAULT_SUBROUTER_BASE_URL = 'http://subrouter.railway.internal:8080';
const DEFAULT_PUBLIC_SUBROUTER_BASE_URL = 'https://api.subrouter.com';
const SESSION_COOKIE = 'od_platform_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_KEY_PREFIX = 'open-design-auto';

export class PlatformError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'PLATFORM_ERROR') {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
  }
}

function truthy(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function falsey(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  return text === '0' || text === 'false' || text === 'no' || text === 'off';
}

export function subrouterPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.OD_PLATFORM_ENABLED ?? env.OPEN_DESIGN_PLATFORM_ENABLED;
  if (explicit !== undefined) return truthy(explicit);
  if (falsey(env.OD_PLATFORM_ENABLED)) return false;
  return Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
}

function now(): number {
  return Date.now();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeBaseUrl(value: string | undefined | null): string {
  let raw = String(value || DEFAULT_SUBROUTER_BASE_URL).trim().replace(/\/+$/, '');
  if (!raw) raw = DEFAULT_SUBROUTER_BASE_URL;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  if (raw.endsWith('/v1')) raw = raw.slice(0, -3).replace(/\/+$/, '');
  return raw;
}

function gatewayBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function parseCandidates(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(/[,\n;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeBaseUrl(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function baseUrlCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return unique([
    env.OD_SUBROUTER_BASE_URL,
    env.OPEN_DESIGN_SUBROUTER_BASE_URL,
    env.SUBROUTER_BASE_URL,
    env.SUBROUTERAI_BASE_URL,
    env.MODEL_GATEWAY_BASE_URL,
    env.TOONFLOW_SUBROUTER_BASE_URL,
    ...parseCandidates(env.OD_SUBROUTER_BASE_URL_CANDIDATES),
    ...parseCandidates(env.SUBROUTER_BASE_URL_CANDIDATES),
    ...parseCandidates(env.MODEL_GATEWAY_BASE_URL_CANDIDATES),
    DEFAULT_SUBROUTER_BASE_URL,
    DEFAULT_PUBLIC_SUBROUTER_BASE_URL,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
}

function normalizeApiKey(key: unknown): string {
  const text = String(key || '').trim().replace(/^Bearer\s+/i, '');
  if (!text) return '';
  return `sk-${text.replace(/^sk-/i, '')}`;
}

function bearer(apiKey: string): string {
  return `Bearer ${normalizeApiKey(apiKey).replace(/^Bearer\s+/i, '')}`;
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'items', 'models', 'list', 'rows']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = extractItems(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function extractUser(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const body = payload as Record<string, unknown>;
  const data = body.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>).user;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return data as Record<string, unknown>;
  }
  const user = body.user;
  return user && typeof user === 'object' && !Array.isArray(user)
    ? user as Record<string, unknown>
    : {};
}

function normalizeHost(value: unknown): string {
  const text = String(value || '').trim();
  return text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function extractDistributor(payload: unknown): Record<string, string> | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const body = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  const raw = body.distributor && typeof body.distributor === 'object' && !Array.isArray(body.distributor)
    ? body.distributor as Record<string, unknown>
    : {};
  const id = String(body.distributor_id ?? body.distributorId ?? raw.id ?? '').trim();
  const belongs =
    body.belongs_to_distributor ??
    body.belongsToDistributor ??
    body.has_distributor ??
    body.hasDistributor ??
    Boolean(id);
  if (!belongs) return null;
  const slug = String(raw.slug ?? body.distributor_slug ?? body.distributorSlug ?? '').trim();
  const domain = normalizeHost(
    raw.domain ??
      raw.site_domain ??
      raw.siteDomain ??
      body.distributor_domain ??
      body.distributorDomain ??
      body.domain,
  );
  if (!id || (!slug && !domain)) {
    throw new PlatformError('当前账号分站信息不完整，请联系管理员');
  }
  return {
    id,
    slug: slug || domain || id,
    name: String(raw.name ?? body.distributor_name ?? body.distributorName ?? '').trim(),
    domain,
  };
}

function extractKey(payload: unknown): { key: string; id: string } {
  const body = payload && typeof payload === 'object' && (payload as Record<string, unknown>).data
    ? (payload as Record<string, unknown>).data
    : payload;
  if (!body || typeof body !== 'object') return { key: '', id: '' };
  const record = body as Record<string, unknown>;
  const nested = record.token || record.key_info || record.keyInfo || record.apiKey || record.api_key;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>;
    return {
      key: normalizeApiKey(nestedRecord.key ?? nestedRecord.api_key ?? nestedRecord.apiKey ?? nestedRecord.token),
      id: String(nestedRecord.id ?? ''),
    };
  }
  return {
    key: normalizeApiKey(record.key ?? record.api_key ?? record.apiKey ?? record.token),
    id: String(record.id ?? ''),
  };
}

function findReusableKey(items: unknown[], exactName?: string): { key: string; id: string } | null {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name || '');
    if (exactName && name !== exactName) continue;
    if (!exactName && !name.startsWith(AUTO_KEY_PREFIX)) continue;
    const key = normalizeApiKey(record.key ?? record.api_key ?? record.apiKey ?? record.token);
    if (key) return { key, id: String(record.id ?? '') };
  }
  return null;
}

function inferModelType(modelId: string, category = ''): 'text' | 'image' | 'video' {
  const text = `${modelId} ${category}`.toLowerCase();
  if (/video|seedance|wan|kling|vidu|veo|sora|runway|hailuo|luma|pixverse/.test(text)) return 'video';
  if (/image|img|seedream|nano|gpt-image|flux|dalle|dall-e|midjourney|mj|ideogram/.test(text)) return 'image';
  return 'text';
}

function modelFromItem(item: unknown): { id: string; label: string; type: string } | null {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const id = String(
      record.model_name ??
        record.modelName ??
        record.model_id ??
        record.modelId ??
        record.id ??
        record.model ??
        record.name ??
        '',
    ).trim();
    if (!id) return null;
    const label = String(record.label ?? record.display_name ?? record.displayName ?? record.name ?? id).trim() || id;
    const category = String(record.category ?? record.type ?? record.model_type ?? record.modelType ?? '');
    return { id, label, type: inferModelType(id, category) };
  }
  const id = String(item || '').trim();
  return id ? { id, label: id, type: inferModelType(id) } : null;
}

function normalizeModels(items: unknown[]): Array<{ id: string; label: string; type: string }> {
  const byId = new Map<string, { id: string; label: string; type: string }>();
  for (const item of items) {
    const model = modelFromItem(item);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function pickDefaultModel(models: Array<{ id: string; type?: string }>): string {
  const textModels = models.filter((model) => model.type === 'text' && model.id).map((model) => model.id);
  const candidates = textModels.length > 0 ? textModels : models.map((model) => model.id).filter(Boolean);
  const preferences = [
    /claude.*sonnet|sonnet/i,
    /gpt-5|gpt-4\.?1|gpt-4o|gpt-4|o3|o4/i,
    /deepseek.*(v3|chat|pro)|deepseek-ai\/deepseek/i,
    /qwen.*(max|plus|72b|32b|coder)|qwen3/i,
    /glm.*(5|4\.5|4-5)|kimi|moonshot/i,
  ];
  for (const pattern of preferences) {
    const found = candidates.find((id) => pattern.test(id));
    if (found) return found;
  }
  return candidates[0] ?? '';
}

function publicMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '请求失败');
  return raw.replace(/subrouterai|subrouter/gi, '模型服务');
}

async function parseResponse(response: Response, fallback: string): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new PlatformError(upstreamError(payload, text || fallback), response.status);
  }
  if (payload && typeof payload === 'object' && (payload as Record<string, unknown>).success === false) {
    throw new PlatformError(String((payload as Record<string, unknown>).message || fallback));
  }
  return payload;
}

function upstreamError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      return String(err.message || err.type || fallback);
    }
    if (typeof error === 'string') return error;
    if (record.message) return String(record.message);
    if (record.reason) return String(record.reason);
  }
  return fallback;
}

function setCookieParts(headers: Headers): string[] {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = headers.get('set-cookie');
  if (!single) return [];
  return single.split(/,(?=[^;,]+=)/g);
}

function buildCookie(headers: Headers): string {
  return setCookieParts(headers)
    .map((cookie) => String(cookie).split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function parseCookies(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function slug(value: string, fallback: string): string {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return text || fallback;
}

function userDataDir(dataDir: string, userId: string): string {
  return path.join(dataDir, 'users', slug(userId, 'user'));
}

export class SubrouterPlatform {
  enabled: boolean;
  dataDir: string;
  db: Database.Database;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.enabled = subrouterPlatformEnabled(env);
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'platform.sqlite3'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        subrouter_api_key TEXT NOT NULL DEFAULT '',
        subrouter_base_url TEXT NOT NULL DEFAULT '${DEFAULT_SUBROUTER_BASE_URL}',
        subrouter_external_user_id TEXT NOT NULL DEFAULT '',
        subrouter_session_cookie TEXT NOT NULL DEFAULT '',
        subrouter_api_key_id TEXT NOT NULL DEFAULT '',
        subrouter_distributor_id TEXT NOT NULL DEFAULT '',
        subrouter_distributor_slug TEXT NOT NULL DEFAULT '',
        subrouter_distributor_name TEXT NOT NULL DEFAULT '',
        subrouter_distributor_domain TEXT NOT NULL DEFAULT '',
        default_model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_username
        ON platform_users(username);

      CREATE TABLE IF NOT EXISTS platform_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES platform_users(id) ON DELETE CASCADE
      );
    `);
  }

  health() {
    return { ok: true, enabled: this.enabled };
  }

  async login(username: string, password: string) {
    const cleanUsername = String(username || '').trim();
    const cleanPassword = String(password || '').trim();
    if (!cleanUsername || !cleanPassword) throw new PlatformError('用户名和密码不能为空');

    let lastError: unknown = new PlatformError('登录失败');
    for (const baseUrl of baseUrlCandidates()) {
      try {
        const login = await this.loginSubrouter(baseUrl, cleanUsername, cleanPassword);
        const account = await this.prepareAccount(login, cleanUsername);
        const sessionToken = this.createSession(account.user.id);
        return { sessionToken, ...account };
      } catch (error) {
        lastError = error;
      }
    }
    throw new PlatformError(publicMessage(lastError), 401, 'LOGIN_FAILED');
  }

  async loginSubrouter(baseUrl: string, username: string, password: string) {
    const root = normalizeBaseUrl(baseUrl);
    const response = await fetch(`${root}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      redirect: 'manual',
    });
    const payload = await parseResponse(response, '用户名或密码错误');
    const cookie = buildCookie(response.headers);
    if (!cookie) throw new PlatformError('登录成功但未返回会话信息');
    const user = extractUser(payload);
    const externalUserId = String(user.id || '').trim();
    const headers = this.subrouterHeaders({ session_cookie: cookie, external_user_id: externalUserId });
    let distributor = extractDistributor(payload);
    if (!distributor) {
      distributor = await this.fetchSelfDistributor(root, headers);
    }
    return {
      base_url: root,
      external_user_id: externalUserId,
      username: String(user.username || username),
      email: String(user.email || ''),
      display_name: String(user.display_name || user.displayName || user.username || username),
      session_cookie: cookie,
      distributor,
    };
  }

  async prepareAccount(login: Record<string, unknown>, fallbackUsername: string) {
    const seed = String(login.external_user_id || login.email || login.username || fallbackUsername);
    const userId = `sr_${sha256(`subrouterai:${seed}`).slice(0, 24)}`;
    const key = await this.ensureSubrouterKey(login);
    const models = await this.fetchModelsForLogin(login, key.key);
    const existing = this.rowForUser(userId);
    const modelIds = new Set(models.map((model) => model.id));
    const defaultModel =
      existing?.default_model && modelIds.has(existing.default_model)
        ? existing.default_model
        : pickDefaultModel(models);
    const dist = login.distributor && typeof login.distributor === 'object'
      ? login.distributor as Record<string, string>
      : {};
    const username = this.uniqueUsername(
      slug(String(login.username || fallbackUsername), `account-${userId.slice(-8)}`),
      userId,
    );
    const timestamp = now();
    const common = {
      id: userId,
      username,
      email: String(login.email || ''),
      display_name: String(login.display_name || login.username || fallbackUsername),
      subrouter_api_key: key.key,
      subrouter_base_url: normalizeBaseUrl(String(login.base_url || '')),
      subrouter_external_user_id: String(login.external_user_id || ''),
      subrouter_session_cookie: String(login.session_cookie || ''),
      subrouter_api_key_id: key.id || '',
      subrouter_distributor_id: dist.id || '',
      subrouter_distributor_slug: dist.slug || '',
      subrouter_distributor_name: dist.name || '',
      subrouter_distributor_domain: dist.domain || '',
      default_model: defaultModel,
      updated_at: timestamp,
    };
    if (existing) {
      this.db.prepare(`
        UPDATE platform_users
           SET username = @username,
               email = @email,
               display_name = @display_name,
               subrouter_api_key = @subrouter_api_key,
               subrouter_base_url = @subrouter_base_url,
               subrouter_external_user_id = @subrouter_external_user_id,
               subrouter_session_cookie = @subrouter_session_cookie,
               subrouter_api_key_id = @subrouter_api_key_id,
               subrouter_distributor_id = @subrouter_distributor_id,
               subrouter_distributor_slug = @subrouter_distributor_slug,
               subrouter_distributor_name = @subrouter_distributor_name,
               subrouter_distributor_domain = @subrouter_distributor_domain,
               default_model = @default_model,
               updated_at = @updated_at
         WHERE id = @id
      `).run(common);
    } else {
      this.db.prepare(`
        INSERT INTO platform_users (
          id, username, email, display_name, subrouter_api_key, subrouter_base_url,
          subrouter_external_user_id, subrouter_session_cookie, subrouter_api_key_id,
          subrouter_distributor_id, subrouter_distributor_slug, subrouter_distributor_name,
          subrouter_distributor_domain, default_model, created_at, updated_at
        ) VALUES (
          @id, @username, @email, @display_name, @subrouter_api_key, @subrouter_base_url,
          @subrouter_external_user_id, @subrouter_session_cookie, @subrouter_api_key_id,
          @subrouter_distributor_id, @subrouter_distributor_slug, @subrouter_distributor_name,
          @subrouter_distributor_domain, @default_model, @created_at, @updated_at
        )
      `).run({ ...common, created_at: timestamp });
    }
    return { user: this.publicUser(this.rowForUser(userId)), models, defaultModel };
  }

  uniqueUsername(username: string, userId: string): string {
    let candidate = username;
    let suffix = 0;
    while (this.db.prepare('SELECT 1 FROM platform_users WHERE username = ? AND id != ?').get(candidate, userId)) {
      suffix += 1;
      candidate = `${username}-${suffix}`;
    }
    return candidate;
  }

  rowForUser(userId: string): any {
    return this.db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId) ?? null;
  }

  subrouterHeaders(input: { session_cookie?: string; external_user_id?: string }) {
    const headers: Record<string, string> = {};
    if (input.session_cookie) headers.Cookie = input.session_cookie;
    if (input.external_user_id) headers['New-Api-User'] = input.external_user_id;
    return headers;
  }

  headersFromRow(row: any): Record<string, string> {
    return this.subrouterHeaders({
      session_cookie: row?.subrouter_session_cookie || '',
      external_user_id: row?.subrouter_external_user_id || '',
    });
  }

  distributorHeadersFromLogin(login: any): Record<string, string> {
    const headers = this.subrouterHeaders({
      session_cookie: login.session_cookie,
      external_user_id: login.external_user_id,
    });
    const distributor = login.distributor || {};
    const host = normalizeHost(distributor.domain || distributor.slug || '');
    if (host) headers.Host = host;
    return headers;
  }

  distributorHeadersFromRow(row: any): Record<string, string> {
    const headers = this.headersFromRow(row);
    const host = normalizeHost(row?.subrouter_distributor_domain || row?.subrouter_distributor_slug || '');
    if (host) headers.Host = host;
    return headers;
  }

  async fetchSelfDistributor(baseUrl: string, headers: Record<string, string>) {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/user/self/distributor`, { headers });
    if (response.status === 404) return null;
    const payload = await parseResponse(response, '读取分站信息失败');
    return extractDistributor(payload);
  }

  async listSubrouterKeys(login: any): Promise<unknown[]> {
    const headers = this.subrouterHeaders({
      session_cookie: login.session_cookie,
      external_user_id: login.external_user_id,
    });
    const root = normalizeBaseUrl(login.base_url);
    const url = login.distributor
      ? `${root}/api/user/self/distributor/token/list?page=1&page_size=100`
      : `${root}/api/token/`;
    const payload = await parseResponse(await fetch(url, { headers }), '获取访问密钥列表失败');
    return extractItems(payload);
  }

  async ensureSubrouterKey(login: any): Promise<{ key: string; id: string }> {
    const existing = findReusableKey(await this.listSubrouterKeys(login));
    if (existing) return existing;
    const root = normalizeBaseUrl(login.base_url);
    const headers = {
      ...this.subrouterHeaders({
        session_cookie: login.session_cookie,
        external_user_id: login.external_user_id,
      }),
      'Content-Type': 'application/json',
    };
    const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
    const pathName = login.distributor ? '/api/user/self/distributor/token/create' : '/api/token/';
    const body = login.distributor
      ? { name, key_group_id: 0 }
      : {
          name,
          group: 'subrouter',
          expired_time: -1,
          remain_quota: 0,
          unlimited_quota: true,
          model_limits_enabled: false,
        };
    const payload = await parseResponse(
      await fetch(`${root}${pathName}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      '创建访问密钥失败',
    );
    const created = extractKey(payload);
    if (created.key) return created;
    const fromList = findReusableKey(await this.listSubrouterKeys(login), name);
    if (!fromList) throw new PlatformError('访问密钥已创建但未能从列表读取');
    return fromList;
  }

  async fetchGatewayModels(baseUrl: string, apiKey: string) {
    if (!apiKey) return [];
    const response = await fetch(`${gatewayBaseUrl(baseUrl)}/models`, {
      headers: { Authorization: bearer(apiKey) },
    });
    const payload = await parseResponse(response, '读取模型列表失败');
    return normalizeModels(extractItems(payload));
  }

  async fetchSubscribedModels(rowOrLogin: any) {
    const baseUrl = rowOrLogin.subrouter_base_url || rowOrLogin.base_url;
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/user/self/subrouter/models`, {
      headers: rowOrLogin.subrouter_session_cookie ? this.headersFromRow(rowOrLogin) : this.subrouterHeaders({
        session_cookie: rowOrLogin.session_cookie,
        external_user_id: rowOrLogin.external_user_id,
      }),
    });
    if (response.status === 404) return [];
    const payload = await parseResponse(response, '读取订阅模型失败');
    return normalizeModels(extractItems(payload));
  }

  async fetchDistributorSiteModels(baseUrl: string, headers: Record<string, string>) {
    if (!headers.Host) return [];
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/dist/site/models`, { headers });
    if (response.status === 404) return [];
    const payload = await parseResponse(response, '读取分站模型失败');
    return normalizeModels(extractItems(payload));
  }

  async fetchModelsForLogin(login: any, apiKey: string) {
    if (login.distributor) {
      const siteModels = await this.fetchDistributorSiteModels(
        login.base_url,
        this.distributorHeadersFromLogin(login),
      ).catch(() => []);
      if (siteModels.length > 0) return siteModels;
      return this.fetchGatewayModels(login.base_url, apiKey);
    }
    const subscribed = await this.fetchSubscribedModels(login).catch(() => []);
    if (subscribed.length > 0) return subscribed;
    return this.fetchGatewayModels(login.base_url, apiKey);
  }

  async fetchModels(userId: string) {
    const row = this.rowForUser(userId);
    if (!row) throw new PlatformError('登录已过期，请重新登录', 401, 'SESSION_EXPIRED');
    const apiKey = String(row.subrouter_api_key || '').trim();
    if (!apiKey) throw new PlatformError('当前账号未准备好模型调用密钥，请重新登录');
    let models = [];
    if (row.subrouter_distributor_id) {
      models = await this.fetchDistributorSiteModels(
        row.subrouter_base_url,
        this.distributorHeadersFromRow(row),
      ).catch(() => []);
    } else {
      models = await this.fetchSubscribedModels(row).catch(() => []);
    }
    if (models.length === 0) {
      models = await this.fetchGatewayModels(row.subrouter_base_url, apiKey);
    }
    const modelIds = new Set(models.map((model) => model.id));
    let defaultModel = row.default_model && modelIds.has(row.default_model)
      ? row.default_model
      : pickDefaultModel(models);
    if (defaultModel !== row.default_model) {
      this.setDefaultModel(userId, defaultModel);
    }
    return { models, defaultModel };
  }

  setDefaultModel(userId: string, model: string): void {
    const clean = String(model || '').trim();
    this.db.prepare(
      'UPDATE platform_users SET default_model = ?, updated_at = ? WHERE id = ?',
    ).run(clean, now(), userId);
  }

  runtimeForUser(userId: string) {
    const row = this.rowForUser(userId);
    if (!row) throw new PlatformError('登录已过期，请重新登录', 401, 'SESSION_EXPIRED');
    const apiKey = normalizeApiKey(row.subrouter_api_key);
    if (!apiKey) throw new PlatformError('当前账号未准备好模型调用密钥，请重新登录');
    const baseUrl = gatewayBaseUrl(row.subrouter_base_url);
    const home = path.join(userDataDir(this.dataDir, userId), 'codex-home');
    fs.mkdirSync(home, { recursive: true });
    return {
      userId,
      apiKey,
      baseUrl,
      model: String(row.default_model || ''),
      agentEnv: {
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: apiKey,
        CODEX_API_KEY: apiKey,
        CODEX_HOME: home,
      },
    };
  }

  publicUser(row: any) {
    if (!row) return null;
    const siteName =
      row.subrouter_distributor_name ||
      row.subrouter_distributor_domain ||
      row.subrouter_distributor_slug ||
      '平台账号';
    return {
      id: row.id,
      username: row.username,
      email: row.email || '',
      displayName: row.display_name || row.username,
      account: {
        configured: Boolean(row.subrouter_api_key),
        defaultModel: row.default_model || '',
        siteName,
        accountType: row.subrouter_distributor_id ? 'site' : 'platform',
      },
    };
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO platform_sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sha256(token), userId, timestamp, timestamp, timestamp + SESSION_TTL_MS);
    return token;
  }

  destroySession(token: string): void {
    if (!token) return;
    this.db.prepare('DELETE FROM platform_sessions WHERE token_hash = ?').run(sha256(token));
  }

  sessionUserFromRequest(req: Request) {
    if (!this.enabled) return null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.*
        FROM platform_sessions s
        JOIN platform_users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.expires_at > ?
    `).get(sha256(token), now());
    if (!row) return null;
    this.db.prepare('UPDATE platform_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(now(), sha256(token));
    return this.publicUser(row);
  }

  attachSession(req: Request): void {
    const user = this.sessionUserFromRequest(req);
    if (user) (req as any).platformUser = user;
  }

  currentUser(req: Request) {
    return (req as any).platformUser ?? null;
  }

  stampProjectMetadata(req: Request, metadata: unknown) {
    if (!this.enabled) return metadata ?? null;
    const user = this.currentUser(req);
    if (!user) return metadata ?? null;
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : {};
    return {
      ...base,
      platformUserId: user.id,
      platformUsername: user.username,
    };
  }

  projectBelongsToUser(project: any, user: any): boolean {
    if (!this.enabled) return true;
    if (!project || !user) return false;
    const metadata = project.metadata && typeof project.metadata === 'object' ? project.metadata : {};
    return metadata.platformUserId === user.id;
  }

  projectBelongsToRequest(req: Request, project: any): boolean {
    return this.projectBelongsToUser(project, this.currentUser(req));
  }
}

function isOpenApiPath(req: Request): boolean {
  const pathName = req.path || '';
  if (pathName === '/health' || pathName === '/ready' || pathName === '/version') return true;
  if (pathName.startsWith('/platform/')) return true;
  return false;
}

function cookieIsSecure(req: Request): boolean {
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0]?.trim() === 'https';
}

function sendPlatformError(res: Response, error: unknown): void {
  const status = error instanceof PlatformError ? error.status : 500;
  const code = error instanceof PlatformError ? error.code : 'PLATFORM_ERROR';
  res.status(status).json({
    error: {
      code,
      message: publicMessage(error),
    },
  });
}

export function platformSessionMiddleware(platform: SubrouterPlatform) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!platform.enabled) return next();
    platform.attachSession(req);
    if (isOpenApiPath(req)) return next();
    if (platform.currentUser(req)) return next();
    return res.status(401).json({
      error: { code: 'PLATFORM_LOGIN_REQUIRED', message: '请先登录平台账号' },
    });
  };
}

export function registerSubrouterPlatformRoutes(app: Express, platform: SubrouterPlatform): void {
  app.get('/api/platform/status', (req, res) => {
    platform.attachSession(req);
    res.json({
      enabled: platform.enabled,
      authenticated: Boolean(platform.currentUser(req)),
      user: platform.currentUser(req),
    });
  });

  app.get('/api/platform/me', (req, res) => {
    platform.attachSession(req);
    const user = platform.currentUser(req);
    if (!user) {
      return res.status(401).json({ error: { code: 'PLATFORM_LOGIN_REQUIRED', message: '请先登录平台账号' } });
    }
    res.json({ user });
  });

  app.post('/api/platform/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const result = await platform.login(username, password);
      res.cookie(SESSION_COOKIE, result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieIsSecure(req),
        path: '/',
        maxAge: SESSION_TTL_MS,
      });
      res.json({
        user: result.user,
        models: result.models,
        defaultModel: result.defaultModel,
      });
    } catch (error) {
      sendPlatformError(res, error);
    }
  });

  app.post('/api/platform/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    platform.destroySession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/platform/models', async (req, res) => {
    try {
      platform.attachSession(req);
      const user = platform.currentUser(req);
      if (!user) {
        return res.status(401).json({ error: { code: 'PLATFORM_LOGIN_REQUIRED', message: '请先登录平台账号' } });
      }
      const result = await platform.fetchModels(user.id);
      res.json({ models: result.models, defaultModel: result.defaultModel });
    } catch (error) {
      sendPlatformError(res, error);
    }
  });

  app.post('/api/platform/model', async (req, res) => {
    try {
      platform.attachSession(req);
      const user = platform.currentUser(req);
      if (!user) {
        return res.status(401).json({ error: { code: 'PLATFORM_LOGIN_REQUIRED', message: '请先登录平台账号' } });
      }
      const model = String(req.body?.model || '').trim();
      if (!model) throw new PlatformError('请选择模型');
      platform.setDefaultModel(user.id, model);
      res.json({ ok: true, defaultModel: model });
    } catch (error) {
      sendPlatformError(res, error);
    }
  });
}

