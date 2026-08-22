'use strict';

const ai = require('./ai');
const sites = require('./sites');
const cover = require('./cover');

module.exports = {
  ai,
  sites,
  cover,
  claude: ai,
};
