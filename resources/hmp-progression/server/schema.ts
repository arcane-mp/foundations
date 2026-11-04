const migrations = [
    {
        version: 1,
        name: "create character progression, reward, and managed talent ledgers",
        statements: [
            `CREATE TABLE IF NOT EXISTS hmp_progression_profiles (
                character_id BIGINT UNSIGNED NOT NULL,
                experience_points BIGINT UNSIGNED NOT NULL DEFAULT 0,
                native_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
                talent_points INT UNSIGNED NOT NULL DEFAULT 0,
                revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                applied_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id),
                CONSTRAINT fk_hmp_progression_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            `CREATE TABLE IF NOT EXISTS hmp_progression_rewards (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                reference_id VARCHAR(96) NOT NULL,
                character_id BIGINT UNSIGNED NOT NULL,
                operation VARCHAR(8) NOT NULL,
                amount BIGINT NOT NULL,
                balance_before BIGINT UNSIGNED NULL,
                balance_after BIGINT UNSIGNED NULL,
                actor_character_id BIGINT UNSIGNED NULL,
                source_resource VARCHAR(64) NOT NULL,
                reason_text VARCHAR(191) NOT NULL DEFAULT '',
                metadata_json LONGTEXT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                error_text VARCHAR(191) NOT NULL DEFAULT '',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL DEFAULT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_progression_reward_reference (reference_id),
                KEY idx_hmp_progression_reward_character (character_id, id),
                KEY idx_hmp_progression_reward_status (status, id),
                CONSTRAINT fk_hmp_progression_reward_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE,
                CONSTRAINT fk_hmp_progression_reward_actor FOREIGN KEY (actor_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            `CREATE TABLE IF NOT EXISTS hmp_progression_talents (
                character_id BIGINT UNSIGNED NOT NULL,
                talent_id VARCHAR(128) NOT NULL,
                talent_level SMALLINT UNSIGNED NOT NULL DEFAULT 1,
                status VARCHAR(16) NOT NULL DEFAULT 'owned',
                acquisition VARCHAR(16) NOT NULL DEFAULT 'grant',
                actor_character_id BIGINT UNSIGNED NULL,
                source_resource VARCHAR(64) NOT NULL,
                reason_text VARCHAR(191) NOT NULL DEFAULT '',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id, talent_id),
                KEY idx_hmp_progression_talents_status (character_id, status),
                CONSTRAINT fk_hmp_progression_talent_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE,
                CONSTRAINT fk_hmp_progression_talent_actor FOREIGN KEY (actor_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        ],
    },
    {
        version: 2,
        name: "create the per-character Floo flame ledger",
        statements: [
            `CREATE TABLE IF NOT EXISTS hmp_progression_floo_flames (
                character_id BIGINT UNSIGNED NOT NULL,
                destination_id VARCHAR(64) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id, destination_id),
                CONSTRAINT fk_hmp_progression_floo_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        ],
    },
];

export = { migrations };
