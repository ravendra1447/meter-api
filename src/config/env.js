require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '7000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_DATABASE || 'billing_app',
    user: process.env.DB_USERNAME || 'meteruser',
    password: process.env.DB_PASSWORD || 'meter@123',
  },
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || '',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
  },
};