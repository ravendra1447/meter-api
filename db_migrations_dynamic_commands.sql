CREATE TABLE IF NOT EXISTS `dynamic_meter_commands` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `command_name` varchar(255) NOT NULL UNIQUE,
  `hex_template` text NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

INSERT INTO `dynamic_meter_commands` (`command_name`, `hex_template`, `description`) VALUES 
('read_total_energy', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 33 33 33 33 {{CS}} 16', 'Read Total Energy (DI 00000000)'),
('read_voltage_a', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 33 34 34 35 {{CS}} 16', 'Read Voltage (DI 02010100)'),
('read_current_a', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 33 34 35 35 {{CS}} 16', 'Read Current (DI 02020100)'),
('read_relay_status', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 34 38 33 37 {{CS}} 16', 'Read Relay Status (DI 04000501)'),
('read_relay_status_alt', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 36 38 33 37 {{CS}} 16', 'Read Relay Status Alt (DI 04000503)'),
('read_cutoff_schedule', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 45 33 44 37 {{CS}} 16', 'Read Cutoff Schedule (DI 04110012)'),
('read_current_date_time', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 3F 34 33 37 {{CS}} 16', 'Read Current Date Time (DI 0400010C)'),
('read_date', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 34 34 33 37 {{CS}} 16', 'Read Date (DI 04000101)'),
('read_time', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 11 04 35 34 33 37 {{CS}} 16', 'Read Time (DI 04000102)'),
('enable_schedule', 'FE FE FE FE 68 AA AA AA AA AA AA 68 1F 04 46 47 87 B3 B6 16', 'Enable Schedule Command (Raw Frame)'),
('relay_control_on', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 1C 10 34 B3 33 37 {{PASSWORD_OPERATOR}} 4E 33 33 33 {{CS}} 16', 'Relay ON Command'),
('relay_control_off', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 1C 10 34 B3 33 37 {{PASSWORD_OPERATOR}} 4D 33 33 33 {{CS}} 16', 'Relay OFF Command'),
('relay_trip_schedule', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 1C 10 {{PASSWORD_OPERATOR}} 1A 00 {{SS}} {{MM}} {{HH}} {{DD}} {{MM_MONTH}} {{YY}} {{CS}} 16', 'Schedule Trip Command (Relay Control 1C)'),
('write_cutoff_schedule', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 14 11 45 33 44 37 {{PASSWORD_OPERATOR}} {{MM}} {{HH}} {{DD}} {{MM_MONTH}} {{YY}} {{CS}} 16', 'Write Cutoff Schedule (Write Data 14)'),
('write_date', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 14 10 34 34 33 37 {{PASSWORD_OPERATOR}} {{WW}} {{DD}} {{MM_MONTH}} {{YY}} {{CS}} 16', 'Write Date to Meter RTC'),
('write_time', '68 {{A0}} {{A1}} {{A2}} {{A3}} {{A4}} {{A5}} 68 14 0F 35 34 33 37 {{PASSWORD_OPERATOR}} {{SS}} {{MM}} {{HH}} {{CS}} 16', 'Write Time to Meter RTC')
ON DUPLICATE KEY UPDATE `hex_template` = VALUES(`hex_template`), `description` = VALUES(`description`);
