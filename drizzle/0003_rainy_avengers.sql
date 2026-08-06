CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`ref` text DEFAULT '' NOT NULL,
	`device` text DEFAULT '' NOT NULL,
	`ts` integer NOT NULL
);
