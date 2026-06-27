import type Database from 'better-sqlite3';

/** Minimal surface of http.Server we need (keeps this unit-testable). */
export interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown;
  closeAllConnections?(): void;
}

export interface ShutdownDeps {
  db: Database.Database;
  server: ClosableServer;
  timer: NodeJS.Timeout;
  log?: (msg: string) => void;
}

/**
 * Gracefully stop the server and durably flush the database.
 *
 * Crucially this does NOT wait for `server.close()` to drain connections: the
 * TV kiosk holds a persistent SSE connection that never ends on its own, so a
 * drain-and-then-checkpoint approach hangs until systemd SIGKILLs us and the
 * WAL is never flushed. Instead we stop accepting new connections, force-close
 * existing ones, then checkpoint + close the DB synchronously.
 */
export function gracefulShutdown(signal: string, deps: ShutdownDeps): void {
  const { db, server, timer, log = () => {} } = deps;
  log(`${signal} received, shutting down...`);

  clearInterval(timer);

  // Stop accepting new connections; force-close existing (incl. persistent SSE).
  try {
    server.close();
    server.closeAllConnections?.();
  } catch (err) {
    log(`error closing server: ${(err as Error).message}`);
  }

  // Checkpoint the WAL back into the main DB file, then close cleanly.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    log(`error during db shutdown: ${(err as Error).message}`);
  }
}
