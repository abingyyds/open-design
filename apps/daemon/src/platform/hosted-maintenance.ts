import { once } from 'node:events';
import { createServer } from 'node:http';

import type { StartServerResult } from '../server.js';

const maintenanceMessage = 'Open Design Cloud is temporarily unavailable for security maintenance.';

export async function startHostedMaintenanceServer(
  port: number,
  host: string,
): Promise<StartServerResult> {
  const server = createServer((req, res) => {
    const path = req.url?.split('?', 1)[0];
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isRead && (path === '/api/health' || path === '/health')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, maintenance: true }));
      return;
    }

    res.statusCode = 503;
    if (isRead && path === '/') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(maintenanceMessage);
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: { code: 'HOSTED_MAINTENANCE', message: maintenanceMessage },
    }));
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Hosted maintenance server did not bind a TCP port');
  }
  const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlHost = reportHost.includes(':') && !reportHost.startsWith('[') ? `[${reportHost}]` : reportHost;
  return {
    url: `http://${urlHost}:${address.port}`,
    server,
    shutdown: async () => { server.closeIdleConnections(); },
    routeInventory: [],
  };
}
