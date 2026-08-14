ALTER TABLE `alerts` ADD `post_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `email_sent` integer DEFAULT 0 NOT NULL;