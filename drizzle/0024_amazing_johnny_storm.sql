ALTER TABLE `profiles` ADD `last_search` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `postcodes_state_idx` ON `postcodes` (`state`,`postcode`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `seen_posts_source_seen_idx` ON `seen_posts` (`source_id`,`seen_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `seen_posts_seen_idx` ON `seen_posts` (`seen_at`);
