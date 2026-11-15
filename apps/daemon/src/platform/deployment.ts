// Hosted-deployment detection. Kept dependency-free so origin validation can
// consult it without pulling in the SQLite-backed platform service.

function truthy(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function falsey(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  return text === '0' || text === 'false' || text === 'no' || text === 'off';
}

/**
 * True when the daemon runs as a hosted multi-user platform (Railway, or an
 * explicit OD_PLATFORM_ENABLED) rather than as a loopback-bound local daemon.
 */
export function hostedPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.OD_PLATFORM_ENABLED ?? env.OPEN_DESIGN_PLATFORM_ENABLED;
  if (explicit !== undefined) return truthy(explicit);
  if (falsey(env.OD_PLATFORM_ENABLED)) return false;
  return Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
}

export function hostedMaintenanceRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  // The hosted daemon shares an OS identity with project processes. Keep
  // Railway in maintenance even if an old platform override is present.
  return hostedPlatformEnabled(env) || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
}
