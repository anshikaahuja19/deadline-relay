'use strict';

const { Deadline, DEFAULT_HEADER, MAX_BUDGET, parseBudget } = require('./deadline');
const { deadline, respondGatewayTimeout } = require('./middleware');
const { DeadlineExceededError, CancelledError } = require('./errors');

module.exports = {
  deadline,
  Deadline,
  DeadlineExceededError,
  CancelledError,
  DEFAULT_HEADER,
  MAX_BUDGET,
  parseBudget,
  respondGatewayTimeout,
};
