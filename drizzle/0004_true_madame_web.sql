CREATE TABLE `log_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text,
	`actor` text NOT NULL,
	`event_type` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
