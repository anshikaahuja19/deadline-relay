'use strict';

const { Deadline, DEFAULT_HEADER, parseBudget } = require('./deadline');
const { DeadlineExceededError, CancelledError } = require('./errors');

/**
 * Default response when the budget runs out: 504 with a small JSON body.
 * Does nothing if the handler has already started responding.
 */
function respondGatewayTimeout(req, res, error) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 504;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'Gateway Timeout', code: error.code, message: error.message }));
}

/**
 * Express / Connect / node:http middleware that gives every request a
 * deadline, available as `req.deadline`.
 *
 * @param {object} [options]
 * @param {number} [options.timeout=10000]  Budget when the caller sends none.
 * @param {number} [options.max]  Cap on the caller's budget.
 * @param {string} [options.header='x-request-timeout-ms']
 * @param {number} [options.reserve=0]  Kept back when forwarding downstream.
 * @param {boolean} [options.trustIncoming=true]  Honour the caller's header.
 * @param {(req, res, error) => void} [options.onExpired]  Defaults to a 504.
 * @param {() => number} [options.clock]
 * @param {typeof fetch} [options.fetch]
 * @returns {(req, res, next) => void}
 */
function deadline(options = {}) {
  const {
    timeout = 10_000,
    max,
    header = DEFAULT_HEADER,
    reserve = 0,
    trustIncoming = true,
    onExpired = respondGatewayTimeout,
    clock,
    fetch: fetchImpl,
  } = options;

  for (const [name, value] of [['timeout', timeout], ['max', max], ['reserve', reserve]]) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`deadline(): ${name} must be a non-negative finite number`);
    }
  }
  if (typeof onExpired !== 'function') {
    throw new TypeError('deadline(): onExpired must be a function');
  }

  return function deadlineMiddleware(req, res, next) {
    const incoming = trustIncoming ? parseBudget(req.headers[header.toLowerCase()]) : undefined;
    let budget = incoming ?? timeout;
    if (max !== undefined) budget = Math.min(budget, max);

    const d = new Deadline(budget, { header, reserve, clock, fetch: fetchImpl });
    req.deadline = d;

    // The caller is already out of time: reply immediately, skip the handler.
    if (d.signal.aborted) {
      onExpired(req, res, d.signal.reason);
      return;
    }

    const onAbort = () => {
      if (d.signal.reason instanceof DeadlineExceededError) {
        onExpired(req, res, d.signal.reason);
      }
    };
    d.signal.addEventListener('abort', onAbort, { once: true });

    res.once('finish', () => {
      d.signal.removeEventListener('abort', onAbort);
      d.dispose();
    });
    res.once('close', () => {
      // Closed before the response finished: the client went away.
      if (!res.writableFinished) {
        d.signal.removeEventListener('abort', onAbort);
        d.cancel(new CancelledError('Client closed the connection'));
      }
      d.dispose();
    });

    next();
  };
}

module.exports = { deadline, respondGatewayTimeout };
