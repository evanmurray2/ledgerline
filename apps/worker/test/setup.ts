import { applyD1Migrations, env } from 'cloudflare:test';

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
