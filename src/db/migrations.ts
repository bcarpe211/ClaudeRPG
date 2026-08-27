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
  {
    id: '006_peak_modifier',
    sql: `ALTER TABLE players ADD COLUMN peak_modifier REAL NOT NULL DEFAULT 1;`,
  },
  {
    id: '007_player_cosmetics',
    sql: `
      CREATE TABLE player_cosmetics (
        player_id     INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        wheel_tier    INTEGER NOT NULL DEFAULT 0,
        primary_hue   INTEGER,
        secondary_hue INTEGER,
        weapon_hue    INTEGER,
        updated_at    INTEGER NOT NULL
      );
    `,
  },
  {
    id: '008_player_slot_cosmetics',
    sql: `
      CREATE TABLE player_slot_cosmetics (
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        slot       INTEGER NOT NULL,
        op         TEXT NOT NULL,       -- 'hue' | 'colorize' | 'value'
        hue        INTEGER,             -- 'hue', 'colorize'
        sat        REAL,                -- 'colorize'
        lo         REAL,                -- 'value'
        hi         REAL,                -- 'value'
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, slot)
      );
    `,
  },
  {
    id: '009_player_slot_cosmetic_tone',
    sql: `ALTER TABLE player_slot_cosmetics ADD COLUMN tone REAL;`,
  },
  {
    id: '010_player_slot_cosmetic_revisions',
    sql: `
      CREATE TABLE player_slot_cosmetic_revisions (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        slot      INTEGER NOT NULL,
        session   INTEGER NOT NULL,
        revision  INTEGER NOT NULL,
        PRIMARY KEY (player_id, slot)
      );
      CREATE TABLE player_cosmetic_mutation_sessions (
        player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        session   INTEGER NOT NULL
      );
    `,
  },
  {
    id: '011_player_slot_cosmetic_batches',
    sql: `
      CREATE TABLE player_slot_cosmetic_batches (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session   INTEGER NOT NULL,
        revision  INTEGER NOT NULL,
        digest    TEXT NOT NULL,
        PRIMARY KEY (player_id, session, revision)
      );
    `,
  },
  {
    id: '012_timed_consumables',
    sql: `
      ALTER TABLE game_state ADD COLUMN combat_active_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE encounter_damage ADD COLUMN potion_bonus_damage INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE encounters ADD COLUMN reward_model_version TEXT NOT NULL DEFAULT 'legacy-v0';
      ALTER TABLE encounters ADD COLUMN reward_work_pct REAL;
      ALTER TABLE encounters ADD COLUMN reward_damage_pct REAL;
      ALTER TABLE encounters ADD COLUMN reward_podium_first_pct REAL;
      ALTER TABLE encounters ADD COLUMN reward_podium_second_pct REAL;
      ALTER TABLE encounters ADD COLUMN reward_podium_third_pct REAL;

      CREATE TABLE player_inventory (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, sku)
      );

      CREATE TABLE shop_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
        total_price INTEGER NOT NULL CHECK (total_price >= 0),
        office_day TEXT NOT NULL,
        request_id TEXT NOT NULL,
        inventory_after INTEGER NOT NULL CHECK (inventory_after >= 0),
        gold_after INTEGER NOT NULL CHECK (gold_after >= 0),
        created_at INTEGER NOT NULL,
        UNIQUE (player_id, request_id)
      );
      CREATE INDEX idx_shop_purchases_day ON shop_purchases (player_id, sku, office_day);

      CREATE TABLE player_inventory_lots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL UNIQUE REFERENCES shop_purchases(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
        unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
        purchased_at INTEGER NOT NULL
      );
      CREATE INDEX idx_inventory_lots_fifo
        ON player_inventory_lots (player_id, sku, remaining_quantity, purchased_at, id);

      CREATE TABLE potion_activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        potion_type TEXT NOT NULL CHECK (potion_type IN ('gold','damage')),
        tier INTEGER NOT NULL CHECK (tier >= 1),
        purchase_id INTEGER NOT NULL REFERENCES shop_purchases(id),
        purchase_unit_price INTEGER NOT NULL CHECK (purchase_unit_price >= 0),
        request_id TEXT NOT NULL,
        activation_day TEXT NOT NULL,
        activated_at INTEGER NOT NULL,
        start_game_ms INTEGER NOT NULL,
        expires_game_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed')),
        completed_at INTEGER,
        effect_snapshot TEXT NOT NULL,
        eligible_tokens INTEGER NOT NULL DEFAULT 0,
        base_gold INTEGER NOT NULL DEFAULT 0,
        stretch_gold INTEGER NOT NULL DEFAULT 0,
        potion_bonus_damage INTEGER NOT NULL DEFAULT 0,
        UNIQUE (player_id, request_id)
      );
      CREATE UNIQUE INDEX idx_potion_active_type
        ON potion_activations (player_id, potion_type) WHERE status = 'active';
      CREATE INDEX idx_potion_activation_day
        ON potion_activations (player_id, potion_type, activation_day);

      CREATE TABLE potion_work_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activation_id INTEGER NOT NULL REFERENCES potion_activations(id) ON DELETE CASCADE,
        token_event_id INTEGER NOT NULL REFERENCES token_events(id) ON DELETE CASCADE,
        effective_delta INTEGER NOT NULL CHECK (effective_delta >= 0),
        base_gold INTEGER NOT NULL DEFAULT 0,
        stretch_gold INTEGER NOT NULL DEFAULT 0,
        combat_active_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_potion_work_source
        ON potion_work_events (activation_id, token_event_id);

      CREATE TABLE potion_activation_encounters (
        activation_id INTEGER NOT NULL REFERENCES potion_activations(id) ON DELETE CASCADE,
        encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
        bonus_damage INTEGER NOT NULL DEFAULT 0 CHECK (bonus_damage >= 0),
        PRIMARY KEY (activation_id, encounter_id)
      );

      CREATE TABLE encounter_reward_awards (
        encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        effective_tokens INTEGER NOT NULL,
        damage_total INTEGER NOT NULL,
        potion_bonus_damage INTEGER NOT NULL DEFAULT 0,
        damage_rank INTEGER NOT NULL,
        work_gold INTEGER NOT NULL,
        damage_gold INTEGER NOT NULL,
        podium_gold INTEGER NOT NULL,
        total_gold INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        awarded_at INTEGER NOT NULL,
        PRIMARY KEY (encounter_id, player_id)
      );

      CREATE TABLE gold_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
        reason TEXT NOT NULL,
        source_table TEXT,
        source_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_gold_ledger_source
        ON gold_ledger (player_id, reason, source_table, source_id)
        WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
      INSERT INTO gold_ledger
        (player_id, amount, balance_after, reason, source_table, source_id, created_at)
      SELECT id, gold, gold, 'opening_balance', 'migration_012', CAST(id AS TEXT), created_at
      FROM players;

      CREATE TABLE game_clock_days (
        office_day TEXT PRIMARY KEY,
        active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0)
      );

      CREATE TABLE player_daily_combat (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        office_day TEXT NOT NULL,
        damage INTEGER NOT NULL DEFAULT 0 CHECK (damage >= 0),
        potion_bonus_damage INTEGER NOT NULL DEFAULT 0 CHECK (potion_bonus_damage >= 0),
        PRIMARY KEY (player_id, office_day)
      );
    `,
  },
  {
    id: '013_shop_purchase_stock_snapshot',
    sql: `
      ALTER TABLE shop_purchases
        ADD COLUMN stock_remaining_after INTEGER NOT NULL DEFAULT 0
        CHECK (stock_remaining_after >= 0);

      UPDATE shop_purchases
      SET stock_remaining_after = MAX(
        0,
        CASE
          WHEN json_valid(TRIM(COALESCE(
            (SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'),
            ''
          ))) = 0 THEN 3
          WHEN json_type(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          ))) NOT IN ('integer', 'real') THEN 3
          WHEN json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          )), '$') < 0 THEN 3
          WHEN json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          )), '$') > 9007199254740991 THEN 3
          WHEN json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          )), '$') != CAST(json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          )), '$') AS INTEGER) THEN 3
          ELSE CAST(json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'potion_daily_stock_per_sku'
          )), '$') AS INTEGER)
        END - COALESCE((
          SELECT SUM(prior.quantity)
          FROM shop_purchases AS prior
          WHERE prior.player_id = shop_purchases.player_id
            AND prior.sku = shop_purchases.sku
            AND prior.office_day = shop_purchases.office_day
            AND prior.id <= shop_purchases.id
        ), 0)
      );
    `,
  },
  {
    id: '014_potion_activation_response_snapshots',
    sql: `
      ALTER TABLE potion_activations
        ADD COLUMN inventory_remaining_after INTEGER NOT NULL DEFAULT 0
        CHECK (inventory_remaining_after >= 0);
      ALTER TABLE potion_activations
        ADD COLUMN uses_remaining_after INTEGER NOT NULL DEFAULT 0
        CHECK (uses_remaining_after >= 0);
      ALTER TABLE potion_activations
        ADD COLUMN initial_state TEXT NOT NULL DEFAULT 'armed'
        CHECK (initial_state IN ('armed','active'));

      UPDATE potion_activations
      SET inventory_remaining_after = MAX(
            0,
            COALESCE((
              SELECT SUM(purchase.quantity)
              FROM shop_purchases AS purchase
              WHERE purchase.player_id = potion_activations.player_id
                AND purchase.sku = potion_activations.sku
                AND purchase.created_at <= potion_activations.activated_at
            ), 0) - (
              SELECT COUNT(*)
              FROM potion_activations AS prior
              WHERE prior.player_id = potion_activations.player_id
                AND prior.sku = potion_activations.sku
                AND (
                  prior.activated_at < potion_activations.activated_at
                  OR (
                    prior.activated_at = potion_activations.activated_at
                    AND prior.id <= potion_activations.id
                  )
                )
            )
          ),
          uses_remaining_after = MAX(
            0,
            CASE
              WHEN json_valid(TRIM(COALESCE((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              ), ''))) = 0 THEN 3
              WHEN json_type(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              ))) NOT IN ('integer', 'real') THEN 3
              WHEN json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              )), '$') < 0 THEN 3
              WHEN json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              )), '$') > 9007199254740991 THEN 3
              WHEN json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              )), '$') != CAST(json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              )), '$') AS INTEGER) THEN 3
              ELSE CAST(json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'potion_daily_uses_per_type'
              )), '$') AS INTEGER)
            END - (
              SELECT COUNT(*)
              FROM potion_activations AS prior
              WHERE prior.player_id = potion_activations.player_id
                AND prior.potion_type = potion_activations.potion_type
                AND prior.activation_day = potion_activations.activation_day
                AND (
                  prior.activated_at < potion_activations.activated_at
                  OR (
                    prior.activated_at = potion_activations.activated_at
                    AND prior.id <= potion_activations.id
                  )
                )
            )
      );
    `,
  },
  {
    id: '015_encounter_reward_gold_pool',
    sql: `
      ALTER TABLE encounters
        ADD COLUMN reward_gold_pool INTEGER
        CHECK (
          reward_gold_pool IS NULL
          OR (
            typeof(reward_gold_pool) = 'integer'
            AND reward_gold_pool >= 0
            AND reward_gold_pool <= 9007199254740991
          )
        );

      UPDATE encounters
      SET reward_gold_pool = CASE
        WHEN (
          SELECT SUM(award.total_gold)
          FROM encounter_reward_awards AS award
          WHERE award.encounter_id = encounters.id
        ) BETWEEN 0 AND 9007199254740991
          THEN (
            SELECT SUM(award.total_gold)
            FROM encounter_reward_awards AS award
            WHERE award.encounter_id = encounters.id
          )
        WHEN json_valid(TRIM(COALESCE(
          (SELECT value FROM settings WHERE key = 'gold_factor'),
          ''
        ))) = 1
          AND json_type(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          ))) IN ('integer', 'real')
          AND json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          )), '$') >= 0
          AND json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          )), '$') <= 1.7976931348623157e308
          AND ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'gold_factor'
              )), '$')
          ) BETWEEN 0 AND 9007199254740991
          THEN CAST(ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'gold_factor'
              )), '$')
          ) AS INTEGER)
        WHEN ROUND(
          encounters.max_hp
          * (
              SELECT dungeon.level
              FROM dungeons AS dungeon
              WHERE dungeon.id = encounters.dungeon_id
            )
          * 0.01
        ) BETWEEN 0 AND 9007199254740991
          THEN CAST(ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * 0.01
          ) AS INTEGER)
        ELSE 0
      END
      WHERE reward_model_version = 'hybrid-v1';
    `,
  },
  {
    id: '016_safe_encounter_reward_gold_pool',
    sql: `
      UPDATE encounters
      SET reward_gold_pool = CASE
        WHEN (
          SELECT SUM(award.total_gold)
          FROM encounter_reward_awards AS award
          WHERE award.encounter_id = encounters.id
        ) BETWEEN 0 AND 9007199254740991
          THEN (
            SELECT SUM(award.total_gold)
            FROM encounter_reward_awards AS award
            WHERE award.encounter_id = encounters.id
          )
        WHEN json_valid(TRIM(COALESCE(
          (SELECT value FROM settings WHERE key = 'gold_factor'),
          ''
        ))) = 1
          AND json_type(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          ))) IN ('integer', 'real')
          AND json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          )), '$') >= 0
          AND json_extract(TRIM((
            SELECT value FROM settings WHERE key = 'gold_factor'
          )), '$') <= 1.7976931348623157e308
          AND ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'gold_factor'
              )), '$')
          ) BETWEEN 0 AND 9007199254740991
          THEN CAST(ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * json_extract(TRIM((
                SELECT value FROM settings WHERE key = 'gold_factor'
              )), '$')
          ) AS INTEGER)
        WHEN ROUND(
          encounters.max_hp
          * (
              SELECT dungeon.level
              FROM dungeons AS dungeon
              WHERE dungeon.id = encounters.dungeon_id
            )
          * 0.01
        ) BETWEEN 0 AND 9007199254740991
          THEN CAST(ROUND(
            encounters.max_hp
            * (
                SELECT dungeon.level
                FROM dungeons AS dungeon
                WHERE dungeon.id = encounters.dungeon_id
              )
            * 0.01
          ) AS INTEGER)
        ELSE 0
      END
      WHERE reward_model_version = 'hybrid-v1'
        AND (
          reward_gold_pool IS NULL
          OR typeof(reward_gold_pool) <> 'integer'
          OR reward_gold_pool < 0
          OR reward_gold_pool > 9007199254740991
        );

      CREATE TRIGGER encounters_reward_gold_pool_safe_insert
      BEFORE INSERT ON encounters
      WHEN NEW.reward_gold_pool IS NOT NULL
        AND (
          typeof(NEW.reward_gold_pool) <> 'integer'
          OR NEW.reward_gold_pool < 0
          OR NEW.reward_gold_pool > 9007199254740991
        )
      BEGIN
        SELECT RAISE(ABORT, 'reward_gold_pool must be a non-negative safe integer');
      END;

      CREATE TRIGGER encounters_reward_gold_pool_safe_update
      BEFORE UPDATE OF reward_gold_pool ON encounters
      WHEN NEW.reward_gold_pool IS NOT NULL
        AND (
          typeof(NEW.reward_gold_pool) <> 'integer'
          OR NEW.reward_gold_pool < 0
          OR NEW.reward_gold_pool > 9007199254740991
        )
      BEGIN
        SELECT RAISE(ABORT, 'reward_gold_pool must be a non-negative safe integer');
      END;
    `,
  },
  {
    id: '017_otlp_delivery_keys',
    sql: `
      CREATE TABLE metric_deliveries (
        series_key TEXT NOT NULL,
        time_unix_nano TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (series_key, time_unix_nano)
      ) WITHOUT ROWID;
    `,
  },
  {
    id: '018_potion_lab_query_indexes',
    sql: `
      CREATE INDEX idx_potion_lab_activations_activated
        ON potion_activations (activated_at, id);
      CREATE INDEX idx_potion_lab_activations_player_activated
        ON potion_activations (player_id, activated_at, id);
      CREATE INDEX idx_potion_lab_activations_sku_activated
        ON potion_activations (sku, activated_at, id);
      CREATE INDEX idx_potion_lab_activations_readiness
        ON potion_activations (status, potion_type, player_id);

      CREATE INDEX idx_potion_lab_purchases_created
        ON shop_purchases (created_at, id);
      CREATE INDEX idx_potion_lab_purchases_player_created
        ON shop_purchases (player_id, created_at, id);
      CREATE INDEX idx_potion_lab_purchases_sku_created
        ON shop_purchases (sku, created_at, id);

      CREATE INDEX idx_potion_lab_ledger_created
        ON gold_ledger (created_at, id);
      CREATE INDEX idx_potion_lab_ledger_player_created
        ON gold_ledger (player_id, created_at, id);
    `,
  },
  {
    id: '019_runtime_raiders_runs',
    sql: `
      CREATE TABLE raider_identities (
        player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        dedupe_secret TEXT NOT NULL UNIQUE
          CHECK (
            typeof(dedupe_secret) = 'text'
            AND length(dedupe_secret) = 64
            AND dedupe_secret NOT GLOB '*[^0-9a-f]*'
          ),
        created_at INTEGER NOT NULL
          CHECK (
            typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND 9007199254740991
          )
      );

      CREATE TABLE raider_enrollments (
        code_hash TEXT NOT NULL PRIMARY KEY
          CHECK (
            typeof(code_hash) = 'text'
            AND length(code_hash) = 64
            AND code_hash NOT GLOB '*[^0-9a-f]*'
          ),
        player_id INTEGER NOT NULL
          REFERENCES raider_identities(player_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
          CHECK (
            typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND 9007199254740991
          ),
        expires_at INTEGER NOT NULL
          CHECK (
            typeof(expires_at) = 'integer'
            AND expires_at BETWEEN 0 AND 9007199254740991
            AND expires_at >= created_at
          ),
        consumed_at INTEGER
          CHECK (
            consumed_at IS NULL
            OR (
              typeof(consumed_at) = 'integer'
              AND consumed_at BETWEEN 0 AND 9007199254740991
              AND consumed_at >= created_at
            )
          )
      );
      CREATE INDEX idx_raider_enrollments_player
        ON raider_enrollments (player_id, expires_at);

      CREATE TABLE raider_devices (
        device_id TEXT NOT NULL PRIMARY KEY
          CHECK (
            typeof(device_id) = 'text'
            AND length(device_id) BETWEEN 1 AND 100
          ),
        player_id INTEGER NOT NULL
          REFERENCES raider_identities(player_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE
          CHECK (
            typeof(token_hash) = 'text'
            AND length(token_hash) = 64
            AND token_hash NOT GLOB '*[^0-9a-f]*'
          ),
        companion_version TEXT NOT NULL
          CHECK (
            typeof(companion_version) = 'text'
            AND length(companion_version) BETWEEN 1 AND 100
          ),
        created_at INTEGER NOT NULL
          CHECK (
            typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND 9007199254740991
          ),
        last_seen_at INTEGER
          CHECK (
            last_seen_at IS NULL
            OR (
              typeof(last_seen_at) = 'integer'
              AND last_seen_at BETWEEN 0 AND 9007199254740991
            )
          ),
        revoked_at INTEGER
          CHECK (
            revoked_at IS NULL
            OR (
              typeof(revoked_at) = 'integer'
              AND revoked_at BETWEEN 0 AND 9007199254740991
            )
          )
      );
      CREATE INDEX idx_raider_devices_player
        ON raider_devices (player_id, revoked_at, last_seen_at);

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL
          REFERENCES raider_identities(player_id) ON DELETE CASCADE,
        provider TEXT NOT NULL
          CHECK (provider IN ('codex','claude','omp')),
        surface TEXT NOT NULL
          CHECK (
            (provider = 'codex' AND surface IN ('codex_desktop','codex_cli'))
            OR (provider = 'claude' AND surface = 'claude_code')
            OR (provider = 'omp' AND surface = 'omp')
          ),
        run_key TEXT NOT NULL
          CHECK (
            typeof(run_key) = 'text'
            AND length(run_key) = 64
            AND run_key NOT GLOB '*[^0-9a-f]*'
          ),
        state TEXT NOT NULL
          CHECK (state IN ('open','completed','failed','cancelled')),
        started_at_ms INTEGER NOT NULL
          CHECK (
            typeof(started_at_ms) = 'integer'
            AND started_at_ms BETWEEN 0 AND 9007199254740991
          ),
        terminal_at_ms INTEGER
          CHECK (
            terminal_at_ms IS NULL
            OR (
              typeof(terminal_at_ms) = 'integer'
              AND terminal_at_ms BETWEEN 0 AND 9007199254740991
              AND terminal_at_ms >= started_at_ms
            )
          ),
        last_event_at_ms INTEGER NOT NULL
          CHECK (
            typeof(last_event_at_ms) = 'integer'
            AND last_event_at_ms BETWEEN started_at_ms AND 9007199254740991
          ),
        last_observed_at_ms INTEGER NOT NULL
          CHECK (
            typeof(last_observed_at_ms) = 'integer'
            AND last_observed_at_ms BETWEEN last_event_at_ms AND 9007199254740991
          ),
        usage_input INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_input) = 'integer'
            AND usage_input BETWEEN 0 AND 9007199254740991
          ),
        usage_output INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_output) = 'integer'
            AND usage_output BETWEEN 0 AND 9007199254740991
          ),
        usage_cache_read INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_cache_read) = 'integer'
            AND usage_cache_read BETWEEN 0 AND 9007199254740991
          ),
        usage_cache_write INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_cache_write) = 'integer'
            AND usage_cache_write BETWEEN 0 AND 9007199254740991
          ),
        usage_reasoning_output INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_reasoning_output) = 'integer'
            AND usage_reasoning_output BETWEEN 0 AND 9007199254740991
          ),
        latest_model TEXT
          CHECK (
            latest_model IS NULL
            OR (typeof(latest_model) = 'text' AND length(latest_model) <= 100)
          ),
        latest_effort TEXT
          CHECK (
            latest_effort IS NULL
            OR (typeof(latest_effort) = 'text' AND length(latest_effort) <= 100)
          ),
        policy_version TEXT NOT NULL
          CHECK (
            typeof(policy_version) = 'text'
            AND length(policy_version) BETWEEN 1 AND 100
          ),
        awarded_usage_credit INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(awarded_usage_credit) = 'integer'
            AND awarded_usage_credit BETWEEN 0 AND 9007199254740991
          ),
        awarded_completion_credit INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(awarded_completion_credit) = 'integer'
            AND awarded_completion_credit BETWEEN 0 AND 9007199254740991
          ),
        awarded_duration_credit INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(awarded_duration_credit) = 'integer'
            AND awarded_duration_credit BETWEEN 0 AND 9007199254740991
          ),
        raid_power INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(raid_power) = 'integer'
            AND raid_power BETWEEN 0 AND 9007199254740991
          ),
        created_at INTEGER NOT NULL
          CHECK (
            typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND 9007199254740991
          ),
        updated_at INTEGER NOT NULL
          CHECK (
            typeof(updated_at) = 'integer'
            AND updated_at BETWEEN created_at AND 9007199254740991
          ),
        CHECK (
          (state = 'open' AND terminal_at_ms IS NULL)
          OR (state <> 'open' AND terminal_at_ms IS NOT NULL)
        ),
        UNIQUE (player_id, provider, run_key)
      );
      CREATE INDEX idx_runs_player_updated
        ON runs (player_id, updated_at DESC, id DESC);

      CREATE TABLE run_events (
        event_key TEXT NOT NULL PRIMARY KEY
          CHECK (
            typeof(event_key) = 'text'
            AND length(event_key) = 64
            AND event_key NOT GLOB '*[^0-9a-f]*'
          ),
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL
          REFERENCES raider_devices(device_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL
          CHECK (
            typeof(sequence) = 'integer'
            AND sequence BETWEEN 0 AND 9007199254740991
          ),
        schema_version INTEGER NOT NULL
          CHECK (typeof(schema_version) = 'integer' AND schema_version = 1),
        companion_version TEXT NOT NULL
          CHECK (
            typeof(companion_version) = 'text'
            AND length(companion_version) BETWEEN 1 AND 100
          ),
        provider TEXT NOT NULL
          CHECK (provider IN ('codex','claude','omp')),
        surface TEXT NOT NULL
          CHECK (
            (provider = 'codex' AND surface IN ('codex_desktop','codex_cli'))
            OR (provider = 'claude' AND surface = 'claude_code')
            OR (provider = 'omp' AND surface = 'omp')
          ),
        run_key TEXT NOT NULL
          CHECK (
            typeof(run_key) = 'text'
            AND length(run_key) = 64
            AND run_key NOT GLOB '*[^0-9a-f]*'
          ),
        event_time_ms INTEGER NOT NULL
          CHECK (
            typeof(event_time_ms) = 'integer'
            AND event_time_ms BETWEEN 0 AND 9007199254740991
          ),
        observed_at_ms INTEGER NOT NULL
          CHECK (
            typeof(observed_at_ms) = 'integer'
            AND observed_at_ms BETWEEN event_time_ms AND 9007199254740991
          ),
        started_at_ms INTEGER NOT NULL
          CHECK (
            typeof(started_at_ms) = 'integer'
            AND started_at_ms BETWEEN 0 AND event_time_ms
            AND event_time_ms - started_at_ms <= 604800000
          ),
        state TEXT NOT NULL
          CHECK (state IN ('open','completed','failed','cancelled')),
        usage_input INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_input) = 'integer'
            AND usage_input BETWEEN 0 AND 9007199254740991
          ),
        usage_output INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_output) = 'integer'
            AND usage_output BETWEEN 0 AND 9007199254740991
          ),
        usage_cache_read INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_cache_read) = 'integer'
            AND usage_cache_read BETWEEN 0 AND 9007199254740991
          ),
        usage_cache_write INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_cache_write) = 'integer'
            AND usage_cache_write BETWEEN 0 AND 9007199254740991
          ),
        usage_reasoning_output INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(usage_reasoning_output) = 'integer'
            AND usage_reasoning_output BETWEEN 0 AND 9007199254740991
          ),
        model TEXT
          CHECK (
            model IS NULL
            OR (typeof(model) = 'text' AND length(model) <= 100)
          ),
        effort TEXT
          CHECK (
            effort IS NULL
            OR (typeof(effort) = 'text' AND length(effort) <= 100)
          ),
        policy_version TEXT NOT NULL
          CHECK (
            typeof(policy_version) = 'text'
            AND length(policy_version) BETWEEN 1 AND 100
          ),
        awarded_delta INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(awarded_delta) = 'integer'
            AND awarded_delta BETWEEN 0 AND 9007199254740991
          ),
        received_at INTEGER NOT NULL
          CHECK (
            typeof(received_at) = 'integer'
            AND received_at BETWEEN 0 AND 9007199254740991
          ),
        UNIQUE (run_id, sequence)
      );
    `,
  },
  {
    id: '020_raider_presence',
    sql: `
      CREATE TABLE raider_presence (
        player_id INTEGER PRIMARY KEY
          REFERENCES players(id) ON DELETE CASCADE,
        last_run_activity_at INTEGER NOT NULL
          CHECK (
            typeof(last_run_activity_at) = 'integer'
            AND last_run_activity_at BETWEEN 0 AND 9007199254740991
          )
      );
    `,
  },
  {
    id: '021_raider_device_replacements',
    sql: `
      CREATE TABLE raider_device_replacements (
        operation_id TEXT NOT NULL PRIMARY KEY
          CHECK (
            typeof(operation_id) = 'text'
            AND length(operation_id) = 36
          ),
        old_device_id TEXT NOT NULL UNIQUE
          REFERENCES raider_devices(device_id) ON DELETE CASCADE,
        replacement_device_id TEXT NOT NULL UNIQUE
          REFERENCES raider_devices(device_id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE
          REFERENCES raider_enrollments(code_hash) ON DELETE CASCADE,
        companion_version TEXT NOT NULL
          CHECK (
            typeof(companion_version) = 'text'
            AND length(companion_version) BETWEEN 1 AND 100
          ),
        created_at INTEGER NOT NULL
          CHECK (
            typeof(created_at) = 'integer'
            AND created_at BETWEEN 0 AND 9007199254740991
          ),
        CHECK (old_device_id <> replacement_device_id)
      );
    `,
  },
];
