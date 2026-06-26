export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_players',
    sql: `
      CREATE TABLE players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        class_key TEXT NOT NULL,
        gender TEXT NOT NULL CHECK (gender IN ('M','F')),
        auth_token TEXT NOT NULL UNIQUE,
        level INTEGER NOT NULL DEFAULT 1,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        effective_tokens INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_token_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '002_settings',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
