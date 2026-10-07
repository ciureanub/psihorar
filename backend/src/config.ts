export interface AppEnv {
  port: number;
  host: string;
  adminEmail: string | null;
  adminPassword: string | null;
  adminTokenSecret: string;
  rateLimitPerMinute: number;
  apns: {
    keyId: string;
    teamId: string;
    p8: string;
    bundleId: string;
  } | null;
}

function opt(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/** Reads configuration from environment variables. Secrets never live in code. */
export function loadEnv(): AppEnv {
  const secret = opt('ADMIN_TOKEN_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('ADMIN_TOKEN_SECRET must be set to a random string of at least 32 characters');
  }
  const keyId = opt('APNS_KEY_ID');
  const teamId = opt('APNS_TEAM_ID');
  const p8 = opt('APNS_P8');
  const bundleId = opt('APNS_BUNDLE_ID');
  return {
    port: Number(opt('PORT') ?? 3000),
    host: opt('HOST') ?? '0.0.0.0',
    adminEmail: opt('ADMIN_EMAIL'),
    adminPassword: opt('ADMIN_PASSWORD'),
    adminTokenSecret: secret,
    rateLimitPerMinute: Number(opt('RATE_LIMIT_PER_MINUTE') ?? 120),
    // The .p8 key may be passed with literal "\n" sequences in a single line.
    apns: keyId && teamId && p8 && bundleId ? { keyId, teamId, p8: p8.replace(/\\n/g, '\n'), bundleId } : null,
  };
}
