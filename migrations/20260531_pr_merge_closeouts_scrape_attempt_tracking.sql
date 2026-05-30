ALTER TABLE pr_merge_closeouts ADD COLUMN scrape_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pr_merge_closeouts ADD COLUMN scrape_last_error TEXT;
