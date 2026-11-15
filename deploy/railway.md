# Railway deployment

Railway deployments currently serve a security maintenance page. The daemon
keeps `/api/health` available for Railway and returns HTTP 503 for application
requests. It does not open the platform credential database or start task and
terminal services. Keep the existing volume attached so data is available for
incident review.

## Required variables

```env
NODE_ENV=production
OD_BIND_HOST=0.0.0.0
OD_DATA_DIR=/data
OD_PLATFORM_ENABLED=1
SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
OD_SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
OD_SUBROUTER_GATEWAY_BASE_URL=https://api.subrouter.com
OD_SUBROUTER_RESPONSES_MODELS=
```

The private Railway URL is used for login and account management. Codex model
traffic must use the public gateway because Codex requires `/v1/responses`,
which is not exposed by the current private SubRouter service.
The platform model picker only exposes OpenAI/Codex-shaped models that are
compatible with that Responses transport. If a deployment has an additional
Responses-compatible model id, add it to `OD_SUBROUTER_RESPONSES_MODELS`.

Railway provides `PORT` automatically. Do not set `OD_PORT` unless you have a
specific reason to override local runs.

## Volume

Create one Railway Volume and mount it at:

```text
/data
```

Open Design stores the platform SQLite database, per-user Codex home
directories, projects, uploads, and runtime state under this path.

## Deploy

1. Create a Railway service from `abingyyds/open-design`.
2. Select branch `main`.
3. Keep the root directory as the repository root.
4. Railway will use `railway.toml` and `deploy/Dockerfile`.
5. Add the variables above.
6. Keep the existing volume mounted.
7. Deploy and verify that `/api/health` returns `ok: true` and
   `maintenance: true`, and that the public home page returns HTTP 503.
