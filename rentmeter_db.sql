-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Jun 25, 2026 at 02:39 AM
-- Server version: 10.11.17-MariaDB-cll-lve
-- PHP Version: 8.2.31

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `rentmeter_db`
--

-- --------------------------------------------------------

--
-- Table structure for table `electricity_consumptions`
--

CREATE TABLE `electricity_consumptions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `property_id` bigint(20) UNSIGNED NOT NULL,
  `meter_id` bigint(20) UNSIGNED NOT NULL,
  `previous_reading` decimal(10,2) NOT NULL DEFAULT 0.00,
  `current_reading` decimal(10,2) NOT NULL DEFAULT 0.00,
  `total_consumed_units` decimal(10,2) NOT NULL,
  `tariff_per_unit` decimal(8,2) NOT NULL DEFAULT 0.00,
  `total_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `calculation_date` date NOT NULL,
  `created_by` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `electricity_meters`
--

CREATE TABLE `electricity_meters` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `property_id` bigint(20) UNSIGNED NOT NULL,
  `meter_name` varchar(191) DEFAULT NULL,
  `meter_number` varchar(191) NOT NULL,
  `model_number` varchar(100) DEFAULT NULL,
  `series_number` varchar(100) DEFAULT NULL,
  `meter_type` enum('prepaid','postpaid') NOT NULL DEFAULT 'prepaid',
  `initial_balance` decimal(10,2) NOT NULL DEFAULT 0.00,
  `current_balance` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tariff_per_unit` decimal(8,2) NOT NULL DEFAULT 0.00,
  `last_reading` decimal(10,2) DEFAULT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `electricity_meters`
--

INSERT INTO `electricity_meters` (`id`, `property_id`, `meter_name`, `meter_number`, `model_number`, `series_number`, `meter_type`, `initial_balance`, `current_balance`, `tariff_per_unit`, `last_reading`, `status`, `created_at`, `updated_at`) VALUES
(2, 2, 'Flat 202 Main Meter', 'MTR-002', 'HPL-2050', 'SN-2024-002', 'prepaid', 1000.00, 720.00, 9.00, 85.00, 'active', '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(3, 3, 'Shop 5 Commercial Meter', 'MTR-003', 'L&T-3010', 'SN-2023-105', 'postpaid', 0.00, 0.00, 10.50, 450.00, 'active', '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(4, 1, 'Flat 101 Backup Meter', 'MTR-004', 'GENUS-1020', 'SN-2024-003', 'prepaid', 200.00, 200.00, 8.50, 0.00, 'inactive', '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(5, 4, 'smart', '260514510001', 'DDZY1218', '260514510001', 'postpaid', 10.00, 6.40, 8.00, 1.45, 'active', '2026-06-24 14:49:36', '2026-06-24 20:30:37');

-- --------------------------------------------------------

--
-- Table structure for table `failed_jobs`
--

CREATE TABLE `failed_jobs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `uuid` varchar(191) NOT NULL,
  `connection` text NOT NULL,
  `queue` text NOT NULL,
  `payload` longtext NOT NULL,
  `exception` longtext NOT NULL,
  `failed_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `meters`
--

CREATE TABLE `meters` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `meter_number` varchar(50) NOT NULL,
  `bluetooth_mac` varchar(100) DEFAULT NULL,
  `meter_address` varchar(20) DEFAULT NULL,
  `relay_status` enum('ON','OFF') NOT NULL DEFAULT 'ON',
  `pending_relay_action` varchar(3) DEFAULT NULL,
  `tariff` decimal(10,2) NOT NULL DEFAULT 8.00,
  `month_start_reading` decimal(12,2) NOT NULL DEFAULT 0.00,
  `current_reading` decimal(12,2) NOT NULL DEFAULT 0.00,
  `monthly_usage` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `sim_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `mqtt_online` tinyint(1) NOT NULL DEFAULT 0,
  `last_mqtt_at` timestamp NULL DEFAULT NULL,
  `mqtt_device_id` varchar(50) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `meters`
--

INSERT INTO `meters` (`id`, `meter_number`, `bluetooth_mac`, `meter_address`, `relay_status`, `pending_relay_action`, `tariff`, `month_start_reading`, `current_reading`, `monthly_usage`, `status`, `sim_enabled`, `mqtt_online`, `last_mqtt_at`, `mqtt_device_id`, `created_at`, `updated_at`) VALUES
(2, '260514510001', 'C0:D1:1F:FA:4E:C8', '612005265114', 'ON', NULL, 8.00, 0.00, 2.43, 2.43, 'active', 0, 0, NULL, NULL, '2026-06-23 00:46:17', '2026-06-24 20:30:37');

-- --------------------------------------------------------

--
-- Table structure for table `meter_billing_schedules`
--

CREATE TABLE `meter_billing_schedules` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `owner_id` bigint(20) UNSIGNED NOT NULL,
  `electricity_meter_id` bigint(20) UNSIGNED NOT NULL,
  `smart_meter_id` bigint(20) UNSIGNED DEFAULT NULL,
  `schedule_type` varchar(20) NOT NULL DEFAULT 'monthly',
  `schedule_name` varchar(255) NOT NULL,
  `run_time` varchar(5) NOT NULL,
  `run_day` tinyint(3) UNSIGNED DEFAULT NULL,
  `timezone` varchar(50) NOT NULL DEFAULT 'Asia/Kolkata',
  `data_points` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`data_points`)),
  `protocol` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`protocol`)),
  `action` varchar(50) NOT NULL DEFAULT 'read_data',
  `billing` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`billing`)),
  `notifications` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`notifications`)),
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `last_run` timestamp NULL DEFAULT NULL,
  `next_run` timestamp NULL DEFAULT NULL,
  `bill_generated` tinyint(1) NOT NULL DEFAULT 0,
  `last_units_used` decimal(12,2) DEFAULT NULL,
  `last_amount` decimal(12,2) DEFAULT NULL,
  `last_due_date` date DEFAULT NULL,
  `last_grace_end` date DEFAULT NULL,
  `last_disconnect_date` date DEFAULT NULL,
  `last_billing_status` varchar(20) DEFAULT NULL,
  `last_relay_status` varchar(10) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `meter_readings`
--

CREATE TABLE `meter_readings` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `meter_id` bigint(20) UNSIGNED NOT NULL,
  `reading_date` date NOT NULL,
  `total_reading` decimal(12,2) NOT NULL,
  `daily_consumption` decimal(12,2) NOT NULL DEFAULT 0.00,
  `voltage` decimal(10,2) DEFAULT NULL,
  `current` decimal(10,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `meter_readings`
--

INSERT INTO `meter_readings` (`id`, `meter_id`, `reading_date`, `total_reading`, `daily_consumption`, `voltage`, `current`, `created_at`) VALUES
(2, 2, '2026-06-23', 0.00, 0.00, NULL, NULL, '2026-06-23 00:46:17'),
(3, 2, '2026-06-23', 0.03, 0.03, 190.60, 0.03, '2026-06-23 00:50:55'),
(4, 2, '2026-06-23', 0.03, 0.00, 191.00, 0.03, '2026-06-23 00:52:12'),
(5, 2, '2026-06-23', 0.03, 0.00, 191.30, 0.03, '2026-06-23 00:53:26'),
(6, 2, '2026-06-23', 0.03, 0.00, 192.20, 0.03, '2026-06-23 00:54:28'),
(7, 2, '2026-06-23', 0.03, 0.00, 192.60, 0.03, '2026-06-23 01:12:51'),
(8, 2, '2026-06-23', 0.03, 0.00, 196.50, 0.03, '2026-06-23 01:30:36'),
(9, 2, '2026-06-23', 0.03, 0.00, 196.20, 0.03, '2026-06-23 01:32:27'),
(10, 2, '2026-06-23', 0.03, 0.00, 195.30, 0.03, '2026-06-23 01:37:14'),
(11, 2, '2026-06-23', 0.03, 0.00, 194.60, 0.03, '2026-06-23 01:38:43'),
(12, 2, '2026-06-23', 0.03, 0.00, 190.90, 0.03, '2026-06-23 01:52:07'),
(13, 2, '2026-06-23', 0.03, 0.00, 190.20, 0.03, '2026-06-23 01:52:32'),
(14, 2, '2026-06-23', 0.03, 0.00, 191.30, 0.03, '2026-06-23 01:54:20'),
(15, 2, '2026-06-23', 0.03, 0.00, 197.20, 0.03, '2026-06-23 02:07:45'),
(16, 2, '2026-06-23', 0.03, 0.00, 198.80, 0.03, '2026-06-23 02:10:54'),
(17, 2, '2026-06-23', 0.03, 0.00, 199.40, 0.03, '2026-06-23 02:15:33'),
(18, 2, '2026-06-23', 1.82, 1.79, 216.80, 0.43, '2026-06-23 20:29:53'),
(19, 2, '2026-06-23', 1.82, 0.00, 216.90, 0.43, '2026-06-23 20:31:10'),
(20, 2, '2026-06-23', 1.82, 0.00, 216.90, 0.43, '2026-06-23 20:32:41'),
(21, 2, '2026-06-23', 1.87, 0.05, 215.00, 0.43, '2026-06-23 21:01:10'),
(22, 2, '2026-06-24', 1.98, 0.11, 218.00, 0.43, '2026-06-24 14:54:45'),
(23, 2, '2026-06-24', 2.03, 0.05, 215.70, 0.43, '2026-06-24 15:29:53'),
(24, 2, '2026-06-24', 2.09, 0.06, 213.00, 0.43, '2026-06-24 16:01:35'),
(25, 2, '2026-06-24', 2.11, 0.02, 212.80, 0.43, '2026-06-24 16:17:55'),
(26, 2, '2026-06-24', 2.15, 0.04, 216.20, 0.43, '2026-06-24 16:52:53'),
(27, 2, '2026-06-24', 2.24, 0.09, 219.90, 0.43, '2026-06-24 17:49:40'),
(28, 2, '2026-06-24', 2.24, 0.00, 219.20, 0.43, '2026-06-24 17:55:47'),
(29, 2, '2026-06-24', 2.24, 0.00, 219.40, 0.43, '2026-06-24 18:05:22'),
(30, 2, '2026-06-24', 2.25, 0.01, 220.00, NULL, '2026-06-24 18:09:06'),
(31, 2, '2026-06-24', 2.26, 0.01, 218.10, 0.43, '2026-06-24 18:20:04'),
(32, 2, '2026-06-24', 2.27, 0.01, 219.10, 0.43, '2026-06-24 18:33:42'),
(33, 2, '2026-06-24', 2.29, 0.02, 220.40, 0.43, '2026-06-24 18:45:39'),
(34, 2, '2026-06-24', 2.31, 0.02, NULL, NULL, '2026-06-24 19:05:12'),
(35, 2, '2026-06-24', 2.32, 0.01, NULL, NULL, '2026-06-24 19:12:07'),
(36, 2, '2026-06-24', 2.34, 0.02, 220.00, 0.44, '2026-06-24 19:24:02'),
(37, 2, '2026-06-24', 2.34, 0.00, 222.40, 0.44, '2026-06-24 19:35:45'),
(38, 2, '2026-06-24', 2.40, 0.06, 214.70, 0.43, '2026-06-24 20:11:21'),
(39, 2, '2026-06-24', 2.43, 0.03, 215.50, 0.43, '2026-06-24 20:30:37');

-- --------------------------------------------------------

--
-- Table structure for table `meter_relay_schedules`
--

CREATE TABLE `meter_relay_schedules` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `meter_id` bigint(20) UNSIGNED NOT NULL,
  `action` enum('ON','OFF') NOT NULL,
  `schedule_time` time NOT NULL,
  `days_of_week` varchar(20) DEFAULT NULL COMMENT 'Comma-separated 0=Sun..6=Sat; null=every day',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_executed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `meter_relay_schedules`
--

INSERT INTO `meter_relay_schedules` (`id`, `meter_id`, `action`, `schedule_time`, `days_of_week`, `is_active`, `last_executed_at`, `created_at`, `updated_at`) VALUES
(3, 2, 'OFF', '13:10:00', NULL, 1, NULL, '2026-06-23 02:09:48', '2026-06-23 02:09:48');

-- --------------------------------------------------------

--
-- Table structure for table `migrations`
--

CREATE TABLE `migrations` (
  `id` int(10) UNSIGNED NOT NULL,
  `migration` varchar(191) NOT NULL,
  `batch` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `migrations`
--

INSERT INTO `migrations` (`id`, `migration`, `batch`) VALUES
(1, '2014_10_12_000000_create_users_table', 1),
(2, '2014_10_12_100000_create_password_reset_tokens_table', 1),
(3, '2019_08_19_000000_create_failed_jobs_table', 1),
(4, '2019_12_14_000001_create_personal_access_tokens_table', 1),
(5, '2024_01_01_000001_create_properties_table', 1),
(6, '2024_01_01_000002_create_property_tenants_table', 1),
(7, '2024_01_01_000003_create_electricity_meters_table', 1),
(8, '2024_01_01_000004_add_master_role_to_users_table', 1),
(9, '2024_01_01_000005_fix_users_role_column_for_sqlite', 1),
(10, '2024_01_01_000006_add_meter_details_to_electricity_meters_table', 1),
(11, '2024_01_01_000007_create_electricity_consumptions_table', 1),
(12, '2024_01_01_000008_create_tenant_bill_configurations_table', 1),
(13, '2024_01_01_000009_create_tenant_unbilled_charges_table', 1),
(14, '2024_01_01_000010_create_tenant_other_active_charges_table', 1),
(15, '2024_01_01_000011_add_readings_to_electricity_consumptions_table', 1),
(16, '2024_01_01_000012_create_meters_table', 1),
(17, '2024_01_01_000013_create_meter_readings_table', 1),
(18, '2024_01_01_000014_create_tenant_payments_table', 1),
(19, '2026_06_22_000001_create_meter_relay_schedules_table', 1),
(20, '2026_06_23_000001_add_sim_mqtt_fields_to_meters_table', 1);

-- --------------------------------------------------------

--
-- Table structure for table `password_reset_tokens`
--

CREATE TABLE `password_reset_tokens` (
  `email` varchar(191) NOT NULL,
  `token` varchar(191) NOT NULL,
  `created_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `personal_access_tokens`
--

CREATE TABLE `personal_access_tokens` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tokenable_type` varchar(191) NOT NULL,
  `tokenable_id` bigint(20) UNSIGNED NOT NULL,
  `name` varchar(191) NOT NULL,
  `token` varchar(64) NOT NULL,
  `abilities` text DEFAULT NULL,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `personal_access_tokens`
--

INSERT INTO `personal_access_tokens` (`id`, `tokenable_type`, `tokenable_id`, `name`, `token`, `abilities`, `last_used_at`, `expires_at`, `created_at`, `updated_at`) VALUES
(60, 'App\\Models\\User', 2, 'auth-token', '65055f9ac59d9ba16008321924232b578b356cc761d80a78ea246bbcf12ce580', '[\"*\"]', '2026-06-24 23:02:43', NULL, '2026-06-24 22:47:43', '2026-06-24 23:02:43'),
(61, 'App\\Models\\User', 4, 'auth-token', '82bcc21c9f526d0924c77d9d3d76cd34a8cc72f10f4de1fc0887c9ff9c183535', '[\"*\"]', '2026-06-25 09:37:07', NULL, '2026-06-25 09:37:07', '2026-06-25 09:37:07');

-- --------------------------------------------------------

--
-- Table structure for table `properties`
--

CREATE TABLE `properties` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `owner_id` bigint(20) UNSIGNED NOT NULL,
  `property_code` varchar(20) NOT NULL,
  `name` varchar(191) NOT NULL,
  `address` text NOT NULL,
  `city` varchar(191) DEFAULT NULL,
  `state` varchar(191) DEFAULT NULL,
  `pincode` varchar(10) DEFAULT NULL,
  `monthly_rent` decimal(10,2) DEFAULT NULL,
  `maintenance_charges` decimal(12,2) NOT NULL DEFAULT 0.00,
  `water_charges` decimal(12,2) NOT NULL DEFAULT 0.00,
  `security_deposit_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `properties`
--

INSERT INTO `properties` (`id`, `owner_id`, `property_code`, `name`, `address`, `city`, `state`, `pincode`, `monthly_rent`, `maintenance_charges`, `water_charges`, `security_deposit_amount`, `status`, `created_at`, `updated_at`) VALUES
(1, 2, 'PROP-FLAT101', 'Flat 101 - Green Heights', '101, Green Heights, Sector 15', 'Noida', 'Uttar Pradesh', '201301', 15000.00, 0.00, 0.00, 0.00, 'active', '2026-06-23 00:46:16', '2026-06-23 00:46:16'),
(2, 2, 'PROP-FLAT202', 'Flat 202 - Green Heights', '202, Green Heights, Sector 15', 'Noida', 'Uttar Pradesh', '201301', 18000.00, 0.00, 0.00, 0.00, 'active', '2026-06-23 00:46:16', '2026-06-23 00:46:16'),
(3, 3, 'PROP-SHOP005', 'Shop 5 - City Mall', 'Shop 5, Ground Floor, City Mall', 'Delhi', 'Delhi', '110001', 25000.00, 0.00, 0.00, 0.00, 'active', '2026-06-23 00:46:16', '2026-06-23 00:46:16'),
(4, 2, 'PROP-UOJG7DJE', 'flate 103', 'noida sector 63', 'Noida', 'Uttar Pradesh', '201301', 15000.00, 0.00, 0.00, 0.00, 'active', '2026-06-23 20:48:11', '2026-06-23 20:48:11');

-- --------------------------------------------------------

--
-- Table structure for table `property_tenants`
--

CREATE TABLE `property_tenants` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `property_id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `move_in_date` date DEFAULT NULL,
  `move_out_date` date DEFAULT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `monthly_rent` decimal(12,2) DEFAULT NULL,
  `water_charges` decimal(12,2) DEFAULT NULL,
  `maintenance_charges` decimal(12,2) DEFAULT NULL,
  `security_deposit_amount` decimal(12,2) DEFAULT NULL,
  `agreement_period_months` smallint(5) UNSIGNED DEFAULT NULL,
  `agreement_from` date DEFAULT NULL,
  `agreement_to` date DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `property_tenants`
--

INSERT INTO `property_tenants` (`id`, `property_id`, `tenant_id`, `move_in_date`, `move_out_date`, `status`, `monthly_rent`, `water_charges`, `maintenance_charges`, `security_deposit_amount`, `agreement_period_months`, `agreement_from`, `agreement_to`, `created_at`, `updated_at`) VALUES
(1, 1, 4, '2025-01-15', NULL, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(2, 2, 5, '2025-03-01', NULL, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(3, 3, 6, '2024-11-10', NULL, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(6, 4, 9, '2026-06-23', NULL, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-06-23 20:57:37', '2026-06-23 20:57:37');

-- --------------------------------------------------------

--
-- Table structure for table `tenant_bill_configurations`
--

CREATE TABLE `tenant_bill_configurations` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `bill_cycle_day` varchar(30) NOT NULL DEFAULT 'last_day_of_month',
  `billing_status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_by` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `tenant_bill_configurations`
--

INSERT INTO `tenant_bill_configurations` (`id`, `tenant_id`, `bill_cycle_day`, `billing_status`, `created_by`, `created_at`, `updated_at`) VALUES
(1, 4, 'last_day_of_month', 'active', 1, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(2, 5, '15', 'active', 1, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(3, 6, 'last_day_of_month', 'active', 1, '2026-06-23 00:46:17', '2026-06-23 00:46:17');

-- --------------------------------------------------------

--
-- Table structure for table `tenant_other_active_charges`
--

CREATE TABLE `tenant_other_active_charges` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `charge_type` enum('water_charges','maintenance_charges') NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `created_by` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `tenant_other_active_charges`
--

INSERT INTO `tenant_other_active_charges` (`id`, `tenant_id`, `charge_type`, `amount`, `status`, `created_by`, `created_at`, `updated_at`) VALUES
(1, 4, 'maintenance_charges', 500.00, 'active', 1, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(2, 5, 'water_charges', 300.00, 'active', 1, '2026-06-23 00:46:17', '2026-06-23 00:46:17');

-- --------------------------------------------------------

--
-- Table structure for table `tenant_payments`
--

CREATE TABLE `tenant_payments` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `method` varchar(30) NOT NULL DEFAULT 'upi',
  `receipt_no` varchar(50) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'success',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `tenant_payments`
--

INSERT INTO `tenant_payments` (`id`, `tenant_id`, `amount`, `method`, `receipt_no`, `status`, `created_at`, `updated_at`) VALUES
(1, 4, 30887.00, 'upi', 'RCP-20260623132656', 'success', '2026-06-23 20:26:56', '2026-06-23 20:26:56'),
(2, 9, 15000.00, 'upi', 'RCP-20260623140333', 'success', '2026-06-23 21:03:33', '2026-06-23 21:03:33'),
(3, 9, 15000.00, 'upi', 'RCP-20260623140606', 'success', '2026-06-23 21:06:06', '2026-06-23 21:06:06'),
(4, 9, 15000.00, 'upi', 'RCP-20260624083221', 'success', '2026-06-24 15:32:21', '2026-06-24 15:32:21'),
(5, 9, 15000.00, 'upi', 'RCP-20260624083520', 'success', '2026-06-24 15:35:20', '2026-06-24 15:35:20');

-- --------------------------------------------------------

--
-- Table structure for table `tenant_property_requests`
--

CREATE TABLE `tenant_property_requests` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `property_id` bigint(20) UNSIGNED NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `tenant_message` text DEFAULT NULL,
  `owner_remark` text DEFAULT NULL,
  `reviewed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tenant_unbilled_charges`
--

CREATE TABLE `tenant_unbilled_charges` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tenant_id` bigint(20) UNSIGNED NOT NULL,
  `electricity_consumption_id` bigint(20) UNSIGNED DEFAULT NULL,
  `activity_type` enum('electricity_consumption','monthly_rental','maintenance_charges','water_charges') NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `created_by` bigint(20) UNSIGNED DEFAULT NULL,
  `status` enum('active','used','cancel') NOT NULL DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `tenant_unbilled_charges`
--

INSERT INTO `tenant_unbilled_charges` (`id`, `tenant_id`, `electricity_consumption_id`, `activity_type`, `amount`, `created_by`, `status`, `created_at`, `updated_at`) VALUES
(1, 4, NULL, 'electricity_consumption', 386.75, 1, 'used', '2026-06-23 00:46:17', '2026-06-23 20:26:56'),
(2, 4, NULL, 'monthly_rental', 15000.00, 1, 'used', '2026-06-23 00:46:17', '2026-06-23 20:26:56');

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `name` varchar(191) NOT NULL,
  `mobile` varchar(15) NOT NULL,
  `email` varchar(191) DEFAULT NULL,
  `role` enum('master','owner','tenant') NOT NULL DEFAULT 'owner',
  `email_verified_at` timestamp NULL DEFAULT NULL,
  `password` varchar(191) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `remember_token` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `name`, `mobile`, `email`, `role`, `email_verified_at`, `password`, `is_active`, `remember_token`, `created_at`, `updated_at`) VALUES
(1, 'Super Master', '9999999999', 'master@billing.app', 'master', NULL, '$2y$12$BbB7HNSW.M4sROKzSQYtHOlkFule.cRoHQcX.fOVYm99hIqcwlQPW', 1, NULL, '2026-06-23 00:46:15', '2026-06-23 00:46:15'),
(2, 'Ravi Kumar', '9876543210', 'ravi@owner.com', 'owner', NULL, '$2y$12$x4wpz66MJRhix7A7Lj5RW.HChD70e74x21d7MdBW3iIC9n2nLzB6G', 1, NULL, '2026-06-23 00:46:16', '2026-06-23 00:46:16'),
(3, 'Priya Sharma', '9876543211', 'priya@owner.com', 'owner', NULL, '$2y$12$cSHMOwCZXIbwMRtT5p9EdeDOz2Zz9esXZDpU2LytA3qaA.mtuFTS2', 1, NULL, '2026-06-23 00:46:16', '2026-06-23 00:46:16'),
(4, 'Amit Singh', '9123456789', 'amit@tenant.com', 'tenant', NULL, '$2y$12$Kxqn5w6ULyUBAo10qnazrOZ/RozM2VV/qu/1Y7MGNSLrMxhmpHcxC', 1, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(5, 'Suresh Verma', '9123456790', 'suresh@tenant.com', 'tenant', NULL, '$2y$12$pMwHDJmfQh9mZCJHto/CX.90mlTJgygPEwxZL9bPBTTZEpH3dbmoW', 1, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(6, 'Neha Gupta', '9123456791', 'neha@tenant.com', 'tenant', NULL, '$2y$12$CWr3t4v4pGRfSbeTsXuD.ec8BMQzz6Beu1uNIrgkFP9gOf9IrDX0G', 1, NULL, '2026-06-23 00:46:17', '2026-06-23 00:46:17'),
(9, 'amit', '9648065956', 'amitk73262@gmail.com', 'tenant', NULL, '$2y$12$R5ao.Bl8gRxdh2hybDC7CeYvfq/Bs4XEYaGjkBYnYVA5/fFvP7xlO', 1, NULL, '2026-06-23 20:57:37', '2026-06-23 20:57:37');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `electricity_consumptions`
--
ALTER TABLE `electricity_consumptions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `electricity_consumptions_property_id_foreign` (`property_id`),
  ADD KEY `electricity_consumptions_meter_id_foreign` (`meter_id`),
  ADD KEY `electricity_consumptions_created_by_foreign` (`created_by`);

--
-- Indexes for table `electricity_meters`
--
ALTER TABLE `electricity_meters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `electricity_meters_meter_number_unique` (`meter_number`),
  ADD UNIQUE KEY `electricity_meters_series_number_unique` (`series_number`),
  ADD KEY `electricity_meters_property_id_foreign` (`property_id`);

--
-- Indexes for table `failed_jobs`
--
ALTER TABLE `failed_jobs`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `failed_jobs_uuid_unique` (`uuid`);

--
-- Indexes for table `meters`
--
ALTER TABLE `meters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `meters_meter_number_unique` (`meter_number`);

--
-- Indexes for table `meter_billing_schedules`
--
ALTER TABLE `meter_billing_schedules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `meter_billing_schedules_owner_id_foreign` (`owner_id`),
  ADD KEY `meter_billing_schedules_electricity_meter_id_foreign` (`electricity_meter_id`),
  ADD KEY `meter_billing_schedules_smart_meter_id_foreign` (`smart_meter_id`);

--
-- Indexes for table `meter_readings`
--
ALTER TABLE `meter_readings`
  ADD PRIMARY KEY (`id`),
  ADD KEY `meter_readings_meter_id_foreign` (`meter_id`);

--
-- Indexes for table `meter_relay_schedules`
--
ALTER TABLE `meter_relay_schedules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `meter_relay_schedules_meter_id_foreign` (`meter_id`);

--
-- Indexes for table `migrations`
--
ALTER TABLE `migrations`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `password_reset_tokens`
--
ALTER TABLE `password_reset_tokens`
  ADD PRIMARY KEY (`email`);

--
-- Indexes for table `personal_access_tokens`
--
ALTER TABLE `personal_access_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `personal_access_tokens_token_unique` (`token`),
  ADD KEY `personal_access_tokens_tokenable_type_tokenable_id_index` (`tokenable_type`,`tokenable_id`);

--
-- Indexes for table `properties`
--
ALTER TABLE `properties`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `properties_property_code_unique` (`property_code`),
  ADD KEY `properties_owner_id_foreign` (`owner_id`);

--
-- Indexes for table `property_tenants`
--
ALTER TABLE `property_tenants`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `property_tenants_property_id_tenant_id_unique` (`property_id`,`tenant_id`),
  ADD KEY `property_tenants_tenant_id_foreign` (`tenant_id`);

--
-- Indexes for table `tenant_bill_configurations`
--
ALTER TABLE `tenant_bill_configurations`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tenant_bill_configurations_tenant_id_unique` (`tenant_id`),
  ADD KEY `tenant_bill_configurations_created_by_foreign` (`created_by`);

--
-- Indexes for table `tenant_other_active_charges`
--
ALTER TABLE `tenant_other_active_charges`
  ADD PRIMARY KEY (`id`),
  ADD KEY `tenant_other_active_charges_tenant_id_foreign` (`tenant_id`),
  ADD KEY `tenant_other_active_charges_created_by_foreign` (`created_by`);

--
-- Indexes for table `tenant_payments`
--
ALTER TABLE `tenant_payments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tenant_payments_receipt_no_unique` (`receipt_no`),
  ADD KEY `tenant_payments_tenant_id_index` (`tenant_id`);

--
-- Indexes for table `tenant_property_requests`
--
ALTER TABLE `tenant_property_requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `tenant_property_requests_property_id_status_index` (`property_id`,`status`),
  ADD KEY `tenant_property_requests_tenant_id_status_index` (`tenant_id`,`status`);

--
-- Indexes for table `tenant_unbilled_charges`
--
ALTER TABLE `tenant_unbilled_charges`
  ADD PRIMARY KEY (`id`),
  ADD KEY `tenant_unbilled_charges_tenant_id_foreign` (`tenant_id`),
  ADD KEY `tenant_unbilled_charges_electricity_consumption_id_foreign` (`electricity_consumption_id`),
  ADD KEY `tenant_unbilled_charges_created_by_foreign` (`created_by`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `users_mobile_unique` (`mobile`),
  ADD UNIQUE KEY `users_email_unique` (`email`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `electricity_consumptions`
--
ALTER TABLE `electricity_consumptions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `electricity_meters`
--
ALTER TABLE `electricity_meters`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `failed_jobs`
--
ALTER TABLE `failed_jobs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `meters`
--
ALTER TABLE `meters`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `meter_billing_schedules`
--
ALTER TABLE `meter_billing_schedules`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `meter_readings`
--
ALTER TABLE `meter_readings`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=40;

--
-- AUTO_INCREMENT for table `meter_relay_schedules`
--
ALTER TABLE `meter_relay_schedules`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `migrations`
--
ALTER TABLE `migrations`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=21;

--
-- AUTO_INCREMENT for table `personal_access_tokens`
--
ALTER TABLE `personal_access_tokens`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=62;

--
-- AUTO_INCREMENT for table `properties`
--
ALTER TABLE `properties`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `property_tenants`
--
ALTER TABLE `property_tenants`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- AUTO_INCREMENT for table `tenant_bill_configurations`
--
ALTER TABLE `tenant_bill_configurations`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `tenant_other_active_charges`
--
ALTER TABLE `tenant_other_active_charges`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `tenant_payments`
--
ALTER TABLE `tenant_payments`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `tenant_property_requests`
--
ALTER TABLE `tenant_property_requests`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tenant_unbilled_charges`
--
ALTER TABLE `tenant_unbilled_charges`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `electricity_consumptions`
--
ALTER TABLE `electricity_consumptions`
  ADD CONSTRAINT `electricity_consumptions_created_by_foreign` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `electricity_consumptions_meter_id_foreign` FOREIGN KEY (`meter_id`) REFERENCES `electricity_meters` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `electricity_consumptions_property_id_foreign` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `electricity_meters`
--
ALTER TABLE `electricity_meters`
  ADD CONSTRAINT `electricity_meters_property_id_foreign` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `meter_billing_schedules`
--
ALTER TABLE `meter_billing_schedules`
  ADD CONSTRAINT `meter_billing_schedules_electricity_meter_id_foreign` FOREIGN KEY (`electricity_meter_id`) REFERENCES `electricity_meters` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meter_billing_schedules_owner_id_foreign` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meter_billing_schedules_smart_meter_id_foreign` FOREIGN KEY (`smart_meter_id`) REFERENCES `meters` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `meter_readings`
--
ALTER TABLE `meter_readings`
  ADD CONSTRAINT `meter_readings_meter_id_foreign` FOREIGN KEY (`meter_id`) REFERENCES `meters` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `meter_relay_schedules`
--
ALTER TABLE `meter_relay_schedules`
  ADD CONSTRAINT `meter_relay_schedules_meter_id_foreign` FOREIGN KEY (`meter_id`) REFERENCES `meters` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `properties`
--
ALTER TABLE `properties`
  ADD CONSTRAINT `properties_owner_id_foreign` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `property_tenants`
--
ALTER TABLE `property_tenants`
  ADD CONSTRAINT `property_tenants_property_id_foreign` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `property_tenants_tenant_id_foreign` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `tenant_bill_configurations`
--
ALTER TABLE `tenant_bill_configurations`
  ADD CONSTRAINT `tenant_bill_configurations_created_by_foreign` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `tenant_bill_configurations_tenant_id_foreign` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `tenant_other_active_charges`
--
ALTER TABLE `tenant_other_active_charges`
  ADD CONSTRAINT `tenant_other_active_charges_created_by_foreign` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `tenant_other_active_charges_tenant_id_foreign` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `tenant_property_requests`
--
ALTER TABLE `tenant_property_requests`
  ADD CONSTRAINT `tenant_property_requests_property_id_foreign` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `tenant_property_requests_tenant_id_foreign` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `tenant_unbilled_charges`
--
ALTER TABLE `tenant_unbilled_charges`
  ADD CONSTRAINT `tenant_unbilled_charges_created_by_foreign` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `tenant_unbilled_charges_electricity_consumption_id_foreign` FOREIGN KEY (`electricity_consumption_id`) REFERENCES `electricity_consumptions` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `tenant_unbilled_charges_tenant_id_foreign` FOREIGN KEY (`tenant_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
