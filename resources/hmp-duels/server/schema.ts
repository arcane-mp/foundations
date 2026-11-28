import type { HmpMySQLMigration } from "../../hmp-mysql/types";

const migrations: HmpMySQLMigration[] = [
    {
        version: 1,
        name: "create duel ratings and match history",
        statements: [
            `CREATE TABLE IF NOT EXISTS hmp_duel_ratings (
                character_id BIGINT UNSIGNED NOT NULL,
                rating INT NOT NULL,
                wins INT UNSIGNED NOT NULL DEFAULT 0,
                losses INT UNSIGNED NOT NULL DEFAULT 0,
                streak INT NOT NULL DEFAULT 0,
                best_streak INT UNSIGNED NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (character_id),
                KEY idx_hmp_duel_ratings_rating (rating, character_id),
                CONSTRAINT fk_hmp_duel_rating_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            `CREATE TABLE IF NOT EXISTS hmp_duel_matches (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                reference_id VARCHAR(96) NOT NULL,
                winner_character_id BIGINT UNSIGNED NULL,
                loser_character_id BIGINT UNSIGNED NULL,
                low_character_id BIGINT UNSIGNED NOT NULL,
                high_character_id BIGINT UNSIGNED NOT NULL,
                low_account_id BIGINT UNSIGNED NULL,
                high_account_id BIGINT UNSIGNED NULL,
                reason VARCHAR(16) NOT NULL,
                rated TINYINT(1) NOT NULL DEFAULT 0,
                winner_before INT NULL,
                winner_after INT NULL,
                loser_before INT NULL,
                loser_after INT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_hmp_duel_matches_reference (reference_id),
                KEY idx_hmp_duel_matches_winner (winner_character_id, id),
                KEY idx_hmp_duel_matches_loser (loser_character_id, id),
                KEY idx_hmp_duel_matches_pair (low_character_id, high_character_id, rated, created_at),
                KEY idx_hmp_duel_matches_accounts (low_account_id, high_account_id, rated, created_at),
                CONSTRAINT fk_hmp_duel_match_winner FOREIGN KEY (winner_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL,
                CONSTRAINT fk_hmp_duel_match_loser FOREIGN KEY (loser_character_id) REFERENCES hmp_characters (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        ],
    },
];

export = { migrations };
