CREATE TABLE `creature` (
	`id` integer PRIMARY KEY NOT NULL,
	`hunger` integer NOT NULL,
	`energy` integer NOT NULL,
	`happiness` integer NOT NULL,
	`cleanliness` integer NOT NULL,
	`activity` text NOT NULL,
	`activity_until` text,
	`last_action` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
