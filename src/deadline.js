'use strict';

const { DeadlineExceededError, CancelledError } = require('./errors');

/** Header carrying the caller's remaining budget, in whole milliseconds. */
const DEFAULT_HEADER = 'x-request-timeout-ms';

// setTimeout overflows above 2^31-1 ms (~24.8 days) and fires immediately,
// so larger budgets are capped to this value.
const MAX_BUDGET = 2 ** 31 - 1;

// A monotonic clock: unaffected by system time changes (NTP, DST, manual).
const defaultClock = () => performance.now();

function assertBudget(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number of milliseconds`);
  }
}

/**
 * Read a budget from a header value. Only plain non-negative integers are
 * accepted ("2500"); anything else returns undefined so callers can fall back.
 *
 * @param {string | string[] | null | undefined} value
 * @returns {number | undefined}
 */
function parseBudget(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const ms = Number(trimmed);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * Read a header from a Node.js headers object or a WHATWG Headers instance.
 */
function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  return headers[name.toLowerCase()];
}

/**
 * Combine several AbortSignals into one that aborts with the first reason.
 * Returns the signal plus a cleanup function that removes the listeners.
 */
function linkSignals(signals) {
  const controller = new AbortController();
  const cleanups = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, cleanup: () => cleanups.forEach((fn) => fn()) };
}

/**
 * A point in time by which some work must finish, with an AbortSignal that
 * fires when that time is reached.
 */
class Deadline {
  /**
   * @param {number} budget  Milliseconds from now until the deadline.
   * @param {object} [options]
   * @param {string} [options.header]  Header used by toHeaders() and fetch().
   * @param {number} [options.reserve=0]  Milliseconds kept back when handing
   *   the budget to a downstream call, so this service has time to respond.
   * @param {Deadline} [options.parent]  Abort when the parent aborts.
   * @param {() => number} [options.clock]  Millisecond clock (for tests).
   * @param {typeof fetch} [options.fetch]  fetch implementation (for tests).
   */
  constructor(budget, options = {}) {
    assertBudget('budget', budget);
    const {
      header = DEFAULT_HEADER,
      reserve = 0,
      parent,
      clock = defaultClock,
      fetch: fetchImpl,
    } = options;
    assertBudget('reserve', reserve);
    if (parent !== undefined && !(parent instanceof Deadline)) {
      throw new TypeError('parent must be a Deadline');
    }

    budget = Math.min(budget, MAX_BUDGET);
    this.budget = budget;
    this.header = header;
    this.reserve = reserve;
    this._clock = clock;
    this._fetch = fetchImpl;
    this._expiresAt = clock() + budget;
    this._controller = new AbortController();
    this._timer = undefined;
    this._unlinkParent = undefined;

    if (parent) {
      if (parent.signal.aborted) {
        this.cancel(parent.signal.reason);
        return;
      }
      const onParentAbort = () => this.cancel(parent.signal.reason);
      parent.signal.addEventListener('abort', onParentAbort, { once: true });
      this._unlinkParent = () => parent.signal.removeEventListener('abort', onParentAbort);
    }

    if (budget === 0) {
      this.cancel(new DeadlineExceededError(budget));
    } else {
      this._timer = setTimeout(() => this.cancel(new DeadlineExceededError(budget)), budget);
      // Never keep the process alive just to fire a deadline.
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  /**
   * Build a deadline from an incoming request's headers.
   *
   * @param {object} headers  req.headers or a Headers instance.
   * @param {object} [options]  Deadline options, plus:
   * @param {number} [options.fallback]  Budget when the header is missing or invalid.
   * @param {number} [options.max]  Upper bound applied to the incoming value.
   * @returns {Deadline | null}  null when there is no header and no fallback.
   */
  static fromHeaders(headers, options = {}) {
    const { fallback, max, ...rest } = options;
    if (fallback !== undefined) assertBudget('fallback', fallback);
    if (max !== undefined) assertBudget('max', max);
    const header = rest.header ?? DEFAULT_HEADER;
    let budget = parseBudget(readHeader(headers, header)) ?? fallback;
    if (budget === undefined) return null;
    if (max !== undefined) budget = Math.min(budget, max);
    return new Deadline(budget, rest);
  }

  /** AbortSignal that aborts when the deadline expires or is cancelled. */
  get signal() {
    return this._controller.signal;
  }

  /** True once the deadline has passed or was cancelled. */
  get expired() {
    return this.signal.aborted || this._clock() >= this._expiresAt;
  }

  /**
   * Milliseconds left, rounded down. 0 once expired or cancelled.
   * @returns {number}
   */
  remaining() {
    if (this.signal.aborted) return 0;
    return Math.max(0, Math.floor(this._expiresAt - this._clock()));
  }

  /** Throw the abort reason if the deadline has expired or was cancelled. */
  throwIfExpired() {
    if (this.signal.aborted) throw this.signal.reason;
    if (this.expired) throw new DeadlineExceededError(this.budget);
  }

  /**
   * Create a deadline for a sub-task: the smaller of `budget` and what is left
   * here (minus `reserve`). It is cancelled when this deadline is.
   *
   * @param {number} [budget=Infinity]
   * @param {{ reserve?: number }} [options]
   * @returns {Deadline}
   */
  child(budget = Infinity, { reserve = this.reserve } = {}) {
    if (budget !== Infinity) assertBudget('budget', budget);
    assertBudget('reserve', reserve);
    const available = Math.max(0, this.remaining() - reserve);
    return new Deadline(Math.min(budget, available), {
      header: this.header,
      reserve: this.reserve,
      clock: this._clock,
      fetch: this._fetch,
      parent: this,
    });
  }

  /**
   * Headers that pass the remaining budget (minus `reserve`) downstream.
   *
   * @param {{ reserve?: number }} [options]
   * @returns {Record<string, string>}
   */
  toHeaders({ reserve = this.reserve } = {}) {
    assertBudget('reserve', reserve);
    return { [this.header]: String(Math.max(0, this.remaining() - reserve)) };
  }

  /**
   * Like fetch(), but forwards the remaining budget in a header and aborts the
   * request when the deadline expires. Rejects with DeadlineExceededError
   * without sending anything if no usable budget is left.
   *
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   * @param {{ reserve?: number }} [options]
   * @returns {Promise<Response>}
   */
  async fetch(input, init = {}, { reserve = this.reserve } = {}) {
    this.throwIfExpired();
    const forwarded = this.remaining() - reserve;
    if (forwarded <= 0) throw new DeadlineExceededError(this.budget);

    const fetchImpl = this._fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation available; pass options.fetch');
    }

    const headers = new Headers(init.headers);
    headers.set(this.header, String(forwarded));
    const { signal, cleanup } = linkSignals([this.signal, init.signal]);
    try {
      return await fetchImpl(input, { ...init, headers, signal });
    } catch (err) {
      // Surface our own reason instead of a generic AbortError.
      if (this.signal.aborted && !(init.signal && init.signal.aborted)) {
        throw this.signal.reason;
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  /**
   * Race a promise (or a function receiving the signal) against the deadline.
   *
   * @template T
   * @param {Promise<T> | ((signal: AbortSignal) => Promise<T>)} task
   * @returns {Promise<T>}
   */
  race(task) {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    const promise = typeof task === 'function' ? task(this.signal) : task;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => {
      this.signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * Abort now. Defaults to a CancelledError reason. Safe to call repeatedly.
   *
   * @param {unknown} [reason]
   */
  cancel(reason = new CancelledError()) {
    if (this.signal.aborted) return;
    this.dispose();
    this._controller.abort(reason);
  }

  /** Stop the timer and detach from the parent without aborting. */
  dispose() {
    clearTimeout(this._timer);
    this._timer = undefined;
    if (this._unlinkParent) {
      this._unlinkParent();
      this._unlinkParent = undefined;
    }
  }
}

module.exports = { Deadline, DEFAULT_HEADER, MAX_BUDGET, parseBudget };
