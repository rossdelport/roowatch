ALTER TABLE `profiles` ADD `stripe_customer_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `subscription_status` text DEFAULT '' NOT NULL;