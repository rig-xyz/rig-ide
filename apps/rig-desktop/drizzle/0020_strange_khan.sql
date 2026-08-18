CREATE TABLE `rig_comments_cache` (
	`binding_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`threads_json` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`binding_id`, `rel_path`)
);
--> statement-breakpoint
CREATE TABLE `rig_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`avatar_url` text,
	`email` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rig_rigs` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`binding_id` text NOT NULL,
	`name` text,
	`first_opened_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`open_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rig_session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`event_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `rig_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rig_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`rig_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`rig_id`) REFERENCES `rig_rigs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rig_rigs_binding_id` ON `rig_rigs` (`binding_id`);--> statement-breakpoint
CREATE INDEX `idx_rig_rigs_last_opened` ON `rig_rigs` (`last_opened_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rig_session_events_session_seq` ON `rig_session_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_rig_sessions_rig_id` ON `rig_sessions` (`rig_id`);