import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { loadEnv } from './config.js';
import { ApnsPushSender, NoopPushSender } from './push/apns.js';
import { PrismaStore } from './store/prisma.js';

const env = loadEnv();
const store = new PrismaStore();

// The admin account comes from the environment: the operator sets it, nobody self-registers.
if (env.adminEmail && env.adminPassword) {
  await store.upsertAdmin(env.adminEmail, await hashPassword(env.adminPassword));
}

const app = await buildApp({
  store,
  push: env.apns ? new ApnsPushSender(env.apns) : new NoopPushSender(),
  adminTokenSecret: env.adminTokenSecret,
  rateLimitPerMinute: env.rateLimitPerMinute,
  logger: true,
});

if (!env.adminEmail || !env.adminPassword) {
  app.log.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: admin login is unavailable');
}
if (!env.apns) app.log.warn('APNs is not configured: push notifications are disabled');

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.port, host: env.host });
