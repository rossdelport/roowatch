ALTER TABLE `profiles` ADD `alert_phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `sms_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `email_enabled` integer DEFAULT 1 NOT NULL;