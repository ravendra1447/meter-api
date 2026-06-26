ALTER TABLE electricity_meters 
ADD COLUMN next_billing_date DATE NULL,
ADD COLUMN grace_period_ends_at DATETIME NULL;
