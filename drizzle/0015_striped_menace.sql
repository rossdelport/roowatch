CREATE TABLE `scan_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` text NOT NULL,
	`source_ids` text NOT NULL,
	`started_at` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL
);
