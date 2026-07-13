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
  {
    id: '003_token_ingestion',
    sql: `
      CREATE TABLE token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        effective_delta INTEGER NOT NULL,
        total_delta INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_token_events_player_ts ON token_events (player_id, ts);

      CREATE TABLE metric_series (
        series_key TEXT PRIMARY KEY,
        last_value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '004_game_engine',
    sql: `
      CREATE TABLE dungeons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level INTEGER NOT NULL,
        theme TEXT NOT NULL,
        seed INTEGER NOT NULL,
        regular_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE encounters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_id INTEGER NOT NULL,
        index_in_dungeon INTEGER NOT NULL,
        kind TEXT NOT NULL,            -- single | pack | boss
        creature_index INTEGER NOT NULL,
        footprint INTEGER NOT NULL,    -- 1 (1x1) or 2 (2x2)
        pack_count INTEGER NOT NULL DEFAULT 1,
        max_hp INTEGER NOT NULL,
        current_hp INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',  -- active | defeated
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        FOREIGN KEY (dungeon_id) REFERENCES dungeons(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_encounters_dungeon ON encounters (dungeon_id, index_in_dungeon);
      CREATE TABLE encounter_damage (
        encounter_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        damage_total INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        max_hit INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (encounter_id, player_id),
        FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE TABLE level_ups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        new_level INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE TABLE game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_dungeon_id INTEGER,
        current_encounter_id INTEGER,
        paused INTEGER NOT NULL DEFAULT 1,
        last_activity_at INTEGER,
        defeat_until INTEGER,
        last_defeat_encounter_id INTEGER
      );
      INSERT INTO game_state (id, paused) VALUES (1, 1);
    `,
  },
  {
    id: '005_monster_attacks',
    sql: `
      CREATE TABLE monster_attacks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        encounter_id INTEGER NOT NULL,
        player_id    INTEGER NOT NULL,
        kind         TEXT NOT NULL,               -- 'gold' | 'debuff'
        gold_delta   INTEGER NOT NULL DEFAULT 0,  -- gold stolen (0 for debuff)
        ts           INTEGER NOT NULL,
        FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_monster_attacks_encounter ON monster_attacks (encounter_id);
    `,
  },
];
