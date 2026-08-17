CREATE TABLE `support_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`from_admin` integer DEFAULT 0 NOT NULL,
	`body` text NOT NULL,
	`read_by_member` integer DEFAULT 0 NOT NULL,
	`read_by_admin` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
