import type { Express, Request } from 'express';
import { hasExternalProjectRoot } from '../projects.js';
import { createApiError } from '@open-design/contracts';
import { ACTIVE_CONTEXT_TTL_MS } from '../constants.js';
import type { RouteDeps } from '../server-context.js';
import { defineJsonRoute, err, mountJsonRoute, ok, type Result } from '../http/index.js';

export interface RegisterActiveContextRoutesDeps extends RouteDeps<'db' | 'http' | 'projectStore'> {
  platform?: {
    enabled: boolean;
    currentUser(req: Request): { id?: string } | null;
    projectBelongsToRequest(req: Request, project: unknown): boolean;
  };
}

// Soft "what is the user looking at right now in Open Design?" channel. The
// web UI POSTs the current project + file on every route change; the MCP
// surface reads it so a coding agent in another repo can resolve "the design
// I have open" without the user typing the project id. In-memory only —
// daemon restart clears it.
interface ActiveContext {
  projectId: string;
  fileName: string | null;
  ts: number;
}

interface ActiveContextStore {
  current: ActiveContext | null;
}

type PostActiveInput =
  | { kind: 'clear' }
  | { kind: 'set'; projectId: string; fileName: string | null };

type PostActiveOutput =
  | { active: false }
  | { active: true; projectId: string; fileName: string | null; ts: number };

type GetActiveOutput =
  | { active: false }
  | {
      active: true;
      projectId: string;
      projectName: string | null;
      fileName: string | null;
      ts: number;
      ageMs: number;
    };

interface ActiveContextDomainDeps {
  store: ActiveContextStore;
  db: unknown;
  getProject: (db: unknown, projectId: string) => { name?: string | null } | null | undefined;
  now: () => number;
  requireOwnedProject?: boolean;
}

function parsePostActive(raw: { body: unknown }): Result<PostActiveInput> {
  const body = (raw.body ?? {}) as Record<string, unknown>;
  if (body.active === false) {
    return ok({ kind: 'clear' });
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!projectId) {
    return err(createApiError('BAD_REQUEST', 'projectId is required'));
  }
  const fileName =
    typeof body.fileName === 'string' && body.fileName.length > 0 ? body.fileName : null;
  return ok({ kind: 'set', projectId, fileName });
}

function handlePostActive(
  input: PostActiveInput,
  deps: ActiveContextDomainDeps,
): Result<PostActiveOutput> {
  if (input.kind === 'clear') {
    deps.store.current = null;
    return ok({ active: false });
  }
  if (deps.requireOwnedProject && !deps.getProject(deps.db, input.projectId)) {
    return err(createApiError('PROJECT_NOT_FOUND', 'project not found'));
  }
  const next: ActiveContext = {
    projectId: input.projectId,
    fileName: input.fileName,
    ts: deps.now(),
  };
  deps.store.current = next;
  return ok({ active: true, ...next });
}

function handleGetActive(
  _input: void,
  deps: ActiveContextDomainDeps,
): Result<GetActiveOutput> {
  const current = deps.store.current;
  if (!current || deps.now() - current.ts > ACTIVE_CONTEXT_TTL_MS) {
    deps.store.current = null;
    return ok({ active: false });
  }
  const project = deps.getProject(deps.db, current.projectId);
  if (deps.requireOwnedProject && !project) {
    deps.store.current = null;
    return ok({ active: false });
  }
  return ok({
    active: true,
    projectId: current.projectId,
    projectName: project?.name ?? null,
    fileName: current.fileName,
    ts: current.ts,
    ageMs: deps.now() - current.ts,
  });
}

export const postActiveRoute = defineJsonRoute<PostActiveInput, PostActiveOutput, ActiveContextDomainDeps>({
  method: 'post',
  path: '/api/active',
  requireSameOrigin: true,
  parse: parsePostActive,
  handle: handlePostActive,
});

export const getActiveRoute = defineJsonRoute<void, GetActiveOutput, ActiveContextDomainDeps>({
  method: 'get',
  path: '/api/active',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetActive,
});

export function registerActiveContextRoutes(app: Express, ctx: RegisterActiveContextRoutesDeps): void {
  const store: ActiveContextStore = { current: null };
  const domainDeps: ActiveContextDomainDeps = {
    store,
    db: ctx.db,
    getProject: ctx.projectStore.getProject,
    now: () => Date.now(),
  };
  const adapter = { resolvedPortRef: ctx.http.resolvedPortRef };
  const platform = ctx.platform;
  if (!platform?.enabled) {
    mountJsonRoute(app, postActiveRoute, domainDeps, adapter);
    mountJsonRoute(app, getActiveRoute, domainDeps, adapter);
    return;
  }

  const tenants = new Map<string, ActiveContextStore>();
  const requestDeps = (req: Request): ActiveContextDomainDeps => {
    const userId = platform.currentUser(req)?.id;
    const now = Date.now();
    for (const [id, state] of tenants) {
      if (!state.current || now - state.current.ts > ACTIVE_CONTEXT_TTL_MS) tenants.delete(id);
    }
    const tenantStore = (userId && tenants.get(userId)) || { current: null };
    if (userId) tenants.set(userId, tenantStore);
    return {
      ...domainDeps,
      store: tenantStore,
      requireOwnedProject: true,
      getProject: (db, projectId) => {
        const project = ctx.projectStore.getProject(db, projectId);
        return userId && project && platform.projectBelongsToRequest(req, project)
          && !hasExternalProjectRoot(project.metadata) ? project : null;
      },
    };
  };
  app.use('/api/active', (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  mountJsonRoute(app, postActiveRoute, domainDeps, adapter, requestDeps);
  mountJsonRoute(app, getActiveRoute, domainDeps, adapter, requestDeps);
}
