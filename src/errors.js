'use strict';

/**
 * The time budget ran out. Used as the AbortSignal reason when a deadline
 * expires, and thrown by deadline.fetch(), race() and throwIfExpired().
 */
class DeadlineExceededError extends Error {
  /**
   * @param {number} [budget]  The original budget in milliseconds.
   */
  constructor(budget) {
    super(
      budget === undefined
        ? 'Deadline exceeded'
        : `Deadline exceeded (budget was ${budget}ms)`
    );
    this.name = 'DeadlineExceededError';
    this.code = 'DEADLINE_EXCEEDED';
    this.budget = budget;
  }
}

/**
 * The work was cancelled before the deadline, e.g. because the client closed
 * the connection or deadline.cancel() was called.
 */
class CancelledError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

module.exports = { DeadlineExceededError, CancelledError };
