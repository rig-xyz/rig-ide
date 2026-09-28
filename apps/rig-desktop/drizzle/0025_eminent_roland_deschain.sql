CREATE TABLE `rig_room_cache` (
	`account_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`relay_host` text NOT NULL,
	`format_version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`bytes` integer NOT NULL,
	`saved_at` integer NOT NULL,
	`opened_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `binding_id`)
);
--> statement-breakpoint
ALTER TABLE `rig_comments_cache` ADD `account_id` text;--> statement-breakpoint
DELETE FROM `rig_comments_cache`;