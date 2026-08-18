ALTER TABLE `profiles` ADD `cancel_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `wizard_draft` text DEFAULT '' NOT NULL;
