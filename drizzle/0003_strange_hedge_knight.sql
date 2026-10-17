CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`host_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`host_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `creature` ADD `room_id` text REFERENCES rooms(id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_creature` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text,
	`hunger` integer NOT NULL,
	`energy` integer NOT NULL,
	`happiness` integer NOT NULL,
	`cleanliness` integer NOT NULL,
	`activity` text NOT NULL,
	`activity_until` text,
	`last_action` text,
	`last_actor_session_id` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`hat` text,
	`neckwear` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_actor_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_creature`("id", "room_id", "hunger", "energy", "happiness", "cleanliness", "activity", "activity_until", "last_action", "last_actor_session_id", "updated_at", "hat", "neckwear") SELECT "id", "room_id", "hunger", "energy", "happiness", "cleanliness", "activity", "activity_until", "last_action", "last_actor_session_id", "updated_at", "hat", "neckwear" FROM `creature`;--> statement-breakpoint
DROP TABLE `creature`;--> statement-breakpoint
ALTER TABLE `__new_creature` RENAME TO `creature`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `creature_room_id_unique` ON `creature` (`room_id`);--> statement-breakpoint
ALTER TABLE `care_events` ADD `room_id` text REFERENCES rooms(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `room_id` text REFERENCES rooms(id);--> statement-breakpoint
-- Data backfill: the one creature this app ever had before rooms existed
-- becomes a fixed default room, `id = 'COMMONS'`, so production's existing
-- Milo, stats and care history survive with zero visitor-facing
-- disruption (PROCESS.md, Decision 13). On a fresh/empty database every
-- statement below matches zero rows — a correct no-op, not a forced
-- default room, so a fresh `pnpm test` run still starts from nothing.
--
-- host_session_id is left NULL here, deliberately: nobody ever hosted this
-- room (it predates rooms entirely), and the most recent actor is not the
-- same thing as the creator — attributing it to whoever last happened to
-- act would misrepresent them as having hosted something they didn't.
--
-- created_at is backfilled from the earliest session this app has ever
-- seen (MIN(sessions.created_at)), not creature.updated_at (which is
-- overwritten by every mutation, so by migration time it would read as
-- "now" and silently reset Milo's displayed age to zero). This mirrors
-- exactly what getMiloAge() used to compute pre-Decision-13 (PROCESS.md,
-- Decision 10) — the oldest evidence this app has of when the shared
-- space was first visited. COALESCE falls back to creature.updated_at
-- only in the edge case where a creature row exists but no session ever
-- has (should not happen in practice — every action requires a session
-- first — but a migration shouldn't fail outright over it).
INSERT INTO `rooms` (`id`, `host_session_id`, `created_at`)
	SELECT 'COMMONS', NULL, COALESCE((SELECT MIN(`created_at`) FROM `sessions`), `updated_at`) FROM `creature` LIMIT 1;--> statement-breakpoint
UPDATE `creature` SET `room_id` = 'COMMONS' WHERE `room_id` IS NULL;--> statement-breakpoint
UPDATE `sessions` SET `room_id` = 'COMMONS' WHERE `room_id` IS NULL
	AND EXISTS (SELECT 1 FROM `rooms` WHERE `rooms`.`id` = 'COMMONS');--> statement-breakpoint
UPDATE `care_events` SET `room_id` = 'COMMONS' WHERE `room_id` IS NULL
	AND EXISTS (SELECT 1 FROM `rooms` WHERE `rooms`.`id` = 'COMMONS');
