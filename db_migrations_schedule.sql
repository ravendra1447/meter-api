ALTER TABLE meters
ADD COLUMN next_cutoff_date DATETIME NULL,
ADD COLUMN pending_schedule_sync BOOLEAN DEFAULT FALSE;
