CREATE TABLE `rig_seen_files` (
	`binding_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`last_viewed_at` integer NOT NULL,
	PRIMARY KEY(`binding_id`, `rel_path`)
);
