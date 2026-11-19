import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { createMyRidoApp, syncSuperAdminFromEnv } from './server/app.js';
import { loadSupabaseWorkspaceSnapshot } from './server/db.js';
import { startInstanceLease, type InstanceLeaseHandle } from './server/instanceLease.js';
import { getSupabaseAdmin } from './server/integrations.js';
import { realtimeHub } from './server/realtime.js';
import { myridoStore } from './server/store.js';

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let httpServer: http.Server | null = null;
let lease: InstanceLeaseHandle | null = null;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[MyRido] Shutting down: ${reason}`);
  setTimeout(() => process.exit(exitCode || 1), 10_000).unref();
  try {
    myridoStore.flushSync();
  } catch (err) {
    console.error('[MyRido] Final local store flush failed:', err);
  }
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
  await lease?.stop();
  process.exit(exitCode);
}

async function startServer() {
  const app = createMyRidoApp();
  const supabase = getSupabaseAdmin();

  if (supabase) {
    // 1) Become the single active writer before loading data, so no other instance keeps writing behind our snapshot.
    if (process.env.MYRIDO_DISABLE_INSTANCE_LEASE === 'true') {
      console.warn('[MyRido] Writer lease disabled (MYRIDO_DISABLE_INSTANCE_LEASE=true). Run exactly one server instance.');
    } else {
      try {
        lease = await startInstanceLease({
          client: supabase,
          onLost: (why) => void shutdown(`writer lease lost (${why})`, 1),
        });
        if (lease.tookOverActiveInstance) {
          // Give the previous instance one heartbeat to notice and stop before we read the database.
          await new Promise((r) => setTimeout(r, lease!.heartbeatMs + 2_000));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (IS_PRODUCTION) {
          throw new Error(`${message}. Apply supabase/migrations/009_data_layer_integrity.sql.`);
        }
        console.warn(`[MyRido] ${message} (continuing in development).`);
      }
    }

    // 2) Load the central database into the working copy.
    try {
      await loadSupabaseWorkspaceSnapshot();
      console.log('MyRido connected to central Supabase PostgreSQL.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (IS_PRODUCTION) {
        // Never serve production traffic from seed/local data when the central database could not be loaded.
        throw new Error(`Supabase snapshot load failed; refusing to start in production: ${message}`);
      }
      console.error('Supabase startup check warning:', message);
    }
  }

  // SuperAdmin signs in only with the mobile number from MYRIDO_SUPERADMIN_PHONE.
  try {
    console.log(`[MyRido] ${await syncSuperAdminFromEnv()}`);
  } catch (err) {
    console.error('[MyRido] SuperAdmin phone sync failed:', err instanceof Error ? err.message : err);
  }

  if (!IS_PRODUCTION) {
    // Imported lazily so the production bundle never needs Vite at runtime.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y' })
    );
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer = http.createServer(app);
  realtimeHub.attachToHttpServer(httpServer);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MyRido Central Server listening on http://0.0.0.0:${PORT} (WebSocket /ws/realtime active)`);
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error('[MyRido UnhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[MyRido UncaughtException]', err);
  // State may be corrupt after an uncaught exception; let the process manager restart us.
  void shutdown('uncaught exception', 1);
});

startServer().catch(async (err) => {
  console.error('[MyRido Server Startup Error]', err);
  await lease?.stop();
  process.exit(1);
});
