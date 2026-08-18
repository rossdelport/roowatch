CREATE TABLE `group_mutation_locks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_visibility_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `group_visibility_attempts_user_day_idx` ON `group_visibility_attempts` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `group_visibility_attempts_created_idx` ON `group_visibility_attempts` (`created_at`);--> statement-breakpoint
CREATE TABLE `group_visibility_checks` (
	`slug` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`snapshot_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'checking' NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`checked_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `private_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target_type` text DEFAULT 'system' NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_actions_created_idx` ON `private_actions` (`created_at`);--> statement-breakpoint
CREATE TABLE `private_cost_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_id` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`reserved_aud_micros` integer DEFAULT 0 NOT NULL,
	`actual_aud_micros` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_cost_allocations_run_user_unique` ON `private_cost_allocations` (`run_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `private_cost_allocations_user_period_status_idx` ON `private_cost_allocations` (`user_id`,`period_start`,`period_end`,`status`);--> statement-breakpoint
CREATE INDEX `private_cost_allocations_run_idx` ON `private_cost_allocations` (`run_id`);--> statement-breakpoint
CREATE TABLE `private_dispatch_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `private_group_states` (
	`source_id` integer PRIMARY KEY NOT NULL,
	`account_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'waiting_for_access' NOT NULL,
	`last_check_at` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`next_check_at` integer DEFAULT 0 NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`posts_collected` integer DEFAULT 0 NOT NULL,
	`spend_aud_micros` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`latest_error_code` text DEFAULT '' NOT NULL,
	`latest_error` text DEFAULT '' NOT NULL,
	`retry_requested_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_group_states_account_idx` ON `private_group_states` (`account_id`);--> statement-breakpoint
CREATE INDEX `private_group_states_next_check_idx` ON `private_group_states` (`next_check_at`);--> statement-breakpoint
CREATE TABLE `private_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text DEFAULT 'emergency' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`kind` text NOT NULL,
	`target_type` text DEFAULT 'system' NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`last_alert_at` integer DEFAULT 0 NOT NULL,
	`next_reminder_at` integer DEFAULT 0 NOT NULL,
	`sms_state` text DEFAULT 'pending' NOT NULL,
	`email_state` text DEFAULT 'pending' NOT NULL,
	`recovery_state` text DEFAULT 'pending' NOT NULL,
	`recovery_sms_state` text DEFAULT 'pending' NOT NULL,
	`recovery_email_state` text DEFAULT 'pending' NOT NULL,
	`resolved_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_incidents_fingerprint_unique` ON `private_incidents` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `private_incidents_status_seen_idx` ON `private_incidents` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `private_scrape_checks` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'scan_group' NOT NULL,
	`source_id` integer DEFAULT 0 NOT NULL,
	`account_id` text DEFAULT '' NOT NULL,
	`worker_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`started_at` integer DEFAULT 0 NOT NULL,
	`finished_at` integer DEFAULT 0 NOT NULL,
	`reserved_aud_micros` integer DEFAULT 0 NOT NULL,
	`actual_aud_micros` integer DEFAULT 0 NOT NULL,
	`proxy_amount_micros` integer DEFAULT 0 NOT NULL,
	`proxy_currency` text DEFAULT 'AUD' NOT NULL,
	`aud_rate_micros` integer DEFAULT 1000000 NOT NULL,
	`proxy_cost_aud_micros` integer DEFAULT 0 NOT NULL,
	`vps_cost_aud_micros` integer DEFAULT 0 NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`posts_collected` integer DEFAULT 0 NOT NULL,
	`chronological_verified` integer DEFAULT 0 NOT NULL,
	`boundary_reached` integer DEFAULT 0 NOT NULL,
	`feed_end_reached` integer DEFAULT 0 NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`error_detail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_scrape_checks_worker_status_deadline_idx` ON `private_scrape_checks` (`worker_id`,`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `private_scrape_checks_source_status_deadline_idx` ON `private_scrape_checks` (`source_id`,`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `private_scrape_checks_account_kind_status_idx` ON `private_scrape_checks` (`account_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `private_scrape_checks_finished_idx` ON `private_scrape_checks` (`finished_at`);--> statement-breakpoint
CREATE TABLE `private_scraper_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`session_status` text DEFAULT 'unknown' NOT NULL,
	`proxy_status` text DEFAULT 'unknown' NOT NULL,
	`last_heartbeat_at` integer DEFAULT 0 NOT NULL,
	`last_health_check_at` integer DEFAULT 0 NOT NULL,
	`last_scan_at` integer DEFAULT 0 NOT NULL,
	`cookie_saved_at` integer DEFAULT 0 NOT NULL,
	`session_expires_at` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`latest_error_code` text DEFAULT '' NOT NULL,
	`latest_error` text DEFAULT '' NOT NULL,
	`validate_requested_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_scraper_accounts_worker_active_idx` ON `private_scraper_accounts` (`worker_id`,`active`);--> statement-breakpoint
CREATE TABLE `private_scraper_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`proxy_status` text DEFAULT 'unknown' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`last_heartbeat_at` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`estimated_max_cost_aud_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `billing_period_start` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `billing_period_end` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `private_budget_status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `private_budget_paused_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `profiles_stripe_customer_idx` ON `profiles` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `profiles_private_budget_status_idx` ON `profiles` (`private_budget_status`);--> statement-breakpoint
ALTER TABLE `sources` ADD `visibility` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `visibility_checked_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sources`
SET `url` = lower(rtrim(trim(`url`), '/'))
WHERE lower(trim(`url`)) LIKE 'https://www.facebook.com/groups/%';--> statement-breakpoint
UPDATE `sources`
SET
	`visibility` = CASE
		WHEN lower(`last_error`) LIKE 'private group:%' THEN 'private'
		ELSE 'public'
	END,
	`visibility_checked_at` = unixepoch() * 1000;--> statement-breakpoint
UPDATE `groups`
SET `status` = 'waiting_for_access'
WHERE
	`status` = 'watching'
	AND `source_id` IN (
		SELECT `id` FROM `sources` WHERE `visibility` = 'private'
	);--> statement-breakpoint
WITH `ranked_private_groups` AS (
	SELECT
		`groups`.`id` AS `group_id`,
		row_number() OVER (
			PARTITION BY `groups`.`user_id`
			ORDER BY `groups`.`id`
		) AS `private_position`,
		CASE coalesce(`profiles`.`plan`, 'local')
			WHEN 'scale' THEN 40
			WHEN 'growth' THEN 10
			ELSE 4
		END AS `private_limit`
	FROM `groups`
	INNER JOIN `sources` ON `sources`.`id` = `groups`.`source_id`
	LEFT JOIN `profiles` ON `profiles`.`user_id` = `groups`.`user_id`
	WHERE `sources`.`visibility` = 'private'
)
UPDATE `groups`
SET `status` = 'plan_limit_private'
WHERE
	`status` = 'waiting_for_access'
	AND `id` IN (
		SELECT `group_id`
		FROM `ranked_private_groups`
		WHERE `private_position` > `private_limit`
	);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`) WHERE "sources"."url" <> '';--> statement-breakpoint
CREATE INDEX `sources_visibility_active_checked_idx` ON `sources` (`visibility`,`active`,`last_checked`);--> statement-breakpoint
CREATE INDEX `groups_user_status_idx` ON `groups` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `groups_source_status_idx` ON `groups` (`source_id`,`status`);
