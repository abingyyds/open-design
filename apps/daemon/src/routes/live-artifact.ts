import type { Express, Request, Response } from 'express';
import { hasExternalProjectRoot } from '../projects.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterLiveArtifactRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'auth' | 'liveArtifacts' | 'projectStore'> {
  platform?: { enabled: boolean; projectBelongsToRequest(req: Request, project: unknown): boolean };
}

export function registerLiveArtifactRoutes(app: Express, ctx: RegisterLiveArtifactRoutesDeps) {
  const { db } = ctx;
  const { sendApiError, sendLiveArtifactRouteError, requireLocalDaemonRequest } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { authorizeToolRequest, requestProjectOverride, requestRunOverride } = ctx.auth;
  const { createLiveArtifact, listLiveArtifacts, updateLiveArtifact, refreshLiveArtifact, emitLiveArtifactEvent, emitLiveArtifactRefreshEvent, readLiveArtifactCode, setLiveArtifactCodeHeaders, ensureLiveArtifactPreview, setLiveArtifactPreviewHeaders, getLiveArtifact, listLiveArtifactRefreshLogEntries, deleteLiveArtifact } = ctx.liveArtifacts;
  const { getProject, updateProject } = ctx.projectStore;
  const requireManagedProject = (req: Request, res: Response, projectId: string): boolean => {
    if (!ctx.platform?.enabled) return true;
    const project = getProject(db, projectId);
    if (!project || !ctx.platform.projectBelongsToRequest(req, project)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return false;
    }
    if (hasExternalProjectRoot(project.metadata)) {
      sendApiError(res, 403, 'FORBIDDEN', 'Hosted projects cannot access server directories');
      return false;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return true;
  };
  if (ctx.platform?.enabled) {
    app.use('/api/live-artifacts', (req, res, next) => {
      const projectId = req.query.projectId;
      if (typeof projectId !== 'string' || !projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }
      if (requireManagedProject(req, res, projectId)) next();
    });
  }
  app.get('/api/live-artifacts', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId,
      });
      res.json({ artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const variant = typeof req.query.variant === 'string' ? req.query.variant : 'rendered';
      if (variant === 'template' || variant === 'rendered-source') {
        const html = await readLiveArtifactCode({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          variant: variant === 'template' ? 'template' : 'rendered',
        });
        setLiveArtifactCodeHeaders(res);
        return res.status(200).send(html);
      }
      if (variant !== 'rendered') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'variant must be rendered, template, or rendered-source');
      }

      const record = await ensureLiveArtifactPreview({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      setLiveArtifactPreviewHeaders(res);
      res.status(200).send(record.html);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/refreshes', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const refreshes = await listLiveArtifactRefreshLogEntries({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ refreshes });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/create', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:create');
      if (!toolGrant) return;
      if (!requireManagedProject(req, res, toolGrant.projectId)) return;
      const { projectId, input, templateHtml, provenanceJson, createdByRunId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (requestRunOverride(createdByRunId, toolGrant.runId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'createdByRunId is derived from the tool token', {
          details: { suppliedRunId: createdByRunId },
        });
      }

      const record = await createLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
        createdByRunId: toolGrant.runId,
      });
      emitLiveArtifactEvent(toolGrant, 'created', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/tools/live-artifacts/list', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:list');
      if (!toolGrant) return;
      if (!requireManagedProject(req, res, toolGrant.projectId)) return;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
      });
      res.json({ artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/update', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:update');
      if (!toolGrant) return;
      if (!requireManagedProject(req, res, toolGrant.projectId)) return;
      const { projectId, artifactId, input, templateHtml, provenanceJson } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        artifactId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
      });
      emitLiveArtifactEvent(toolGrant, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/refresh', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:refresh');
      if (!toolGrant) return;
      if (!requireManagedProject(req, res, toolGrant.projectId)) return;
      const { projectId, artifactId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId: toolGrant.projectId,
          artifactId,
          onStarted: ({ refreshId }: any) => {
            emitLiveArtifactRefreshEvent(toolGrant, { phase: 'started', artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent(toolGrant, {
          phase: 'failed',
          artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent(toolGrant, {
        phase: 'succeeded',
        artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.patch('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
        input: req.body ?? {},
      });
      emitLiveArtifactEvent({ projectId }, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.delete('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const existing = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      await deleteLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      updateProject(db, projectId, {});
      emitLiveArtifactEvent({ projectId }, 'deleted', existing.artifact);
      res.json({ ok: true });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.post('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          onStarted: ({ refreshId }: any) => {
            emitLiveArtifactRefreshEvent({ projectId }, { phase: 'started', artifactId: req.params.artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent({ projectId }, {
          phase: 'failed',
          artifactId: req.params.artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent({ projectId }, {
        phase: 'succeeded',
        artifactId: req.params.artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

}
