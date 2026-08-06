CREATE TABLE `seen_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_name` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`last_checked` integer DEFAULT 0 NOT NULL,
	`last_count` integer DEFAULT 0 NOT NULL,
	`last_matches` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `brief` text DEFAULT '' NOT NULL;