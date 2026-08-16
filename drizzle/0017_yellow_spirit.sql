ALTER TABLE `alerts` ADD `short_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `sms_sent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `sms_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `sms_month` text DEFAULT '' NOT NULL;