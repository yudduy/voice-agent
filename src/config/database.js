/**
 * MongoDB configuration for Foundess Caller
 */
require('dotenv').config();
const mongoose = require('mongoose');

module.exports = {
  uri: process.env.MONGODB_URI,
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    dbName: process.env.DB_NAME || 'foundess'
  }
};
