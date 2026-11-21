'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Deadline,
  DeadlineExceededError,
  CancelledError,
  DEFAULT_HEADER,
  MAX_BUDGET,
  parseBudget,
} = require('../src');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A clock you move by hand, for exact remaining() checks. */
function manualClock(start = 1000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

test('parseBudget', async (t) => {
  await t.test('accepts non-negative integers', () => {
    assert.equal(parseBudget('2500'), 2500);
    assert.equal(parseBudget(' 0 '), 0);
    assert.equal(parseBudget(['300', '900']), 300);
  });
  await t.test('rejects everything else', () => {
    for (const bad of [undefined, null, '', '-1', '1.5', '2s', 'abc', '1e3', '99999999999999999999']) {
      assert.equal(parseBudget(bad), undefined, String(bad));
    }
  });
});

test('remaining() and expired follow the clock', () => {
  const clock = manualClock();
  const d = new Deadline(1000, { clock });
  assert.equal(d.remaining(), 1000);
  assert.equal(d.expired, false);
  clock.advance(250.7);
  assert.equal(d.remaining(), 749);
  clock.advance(749.3);
  assert.equal(d.remaining(), 0);
  assert.equal(d.expired, true);
  d.dispose();
});

test('the signal aborts with DeadlineExceededError when time runs out', async () => {
  const d = new Deadline(20);
  assert.equal(d.signal.aborted, false);
  await sleep(40);
  assert.equal(d.signal.aborted, true);
  assert.ok(d.signal.reason instanceof DeadlineExceededError);
  assert.equal(d.signal.reason.code, 'DEADLINE_EXCEEDED');
  assert.equal(d.signal.reason.budget, 20);
  assert.equal(d.remaining(), 0);
});

test('a zero budget is expired immediately', () => {
  const d = new Deadline(0);
  assert.equal(d.signal.aborted, true);
  assert.ok(d.signal.reason instanceof DeadlineExceededError);
});

test('huge budgets are capped so the timer does not overflow', async () => {
  const d = new Deadline(Number.MAX_SAFE_INTEGER);
  assert.equal(d.budget, MAX_BUDGET);
  await sleep(10);
  assert.equal(d.signal.aborted, false);
  d.dispose();
});

test('validates arguments', () => {
  for (const bad of [-1, NaN, Infinity, '100', undefined]) {
    assert.throws(() => new Deadline(bad), TypeError, String(bad));
  }
  assert.throws(() => new Deadline(10, { reserve: -5 }), TypeError);
  assert.throws(() => new Deadline(10, { parent: {} }), /parent must be a Deadline/);
});

test('cancel()', async (t) => {
  await t.test('aborts with CancelledError by default', () => {
    const d = new Deadline(1000);
    d.cancel();
    assert.ok(d.signal.reason instanceof CancelledError);
    assert.equal(d.signal.reason.code, 'CANCELLED');
    assert.equal(d.remaining(), 0);
    assert.equal(d.expired, true);
  });
  await t.test('accepts a custom reason and is idempotent', () => {
    const d = new Deadline(1000);
    const reason = new Error('shutdown');
    d.cancel(reason);
    d.cancel(new Error('second'));
    assert.equal(d.signal.reason, reason);
  });
});

test('dispose() stops the timer without aborting', async () => {
  const d = new Deadline(20);
  d.dispose();
  await sleep(40);
  assert.equal(d.signal.aborted, false);
});

test('throwIfExpired()', () => {
  const clock = manualClock();
  const d = new Deadline(100, { clock });
  assert.doesNotThrow(() => d.throwIfExpired());
  clock.advance(100);
  assert.throws(() => d.throwIfExpired(), DeadlineExceededError);
  d.cancel(new Error('custom'));
  assert.throws(() => d.throwIfExpired(), /custom/);
});

test('toHeaders()', async (t) => {
  const clock = manualClock();
  await t.test('forwards the remaining budget', () => {
    const d = new Deadline(1000, { clock });
    assert.deepEqual(d.toHeaders(), { [DEFAULT_HEADER]: '1000' });
    clock.advance(400);
    assert.deepEqual(d.toHeaders(), { [DEFAULT_HEADER]: '600' });
    d.dispose();
  });
  await t.test('subtracts the reserve and never goes negative', () => {
    const d = new Deadline(100, { clock, reserve: 30 });
    assert.deepEqual(d.toHeaders(), { [DEFAULT_HEADER]: '70' });
    assert.deepEqual(d.toHeaders({ reserve: 500 }), { [DEFAULT_HEADER]: '0' });
    d.dispose();
  });
  await t.test('uses a custom header name', () => {
    const d = new Deadline(50, { clock, header: 'grpc-like-timeout' });
    assert.deepEqual(d.toHeaders(), { 'grpc-like-timeout': '50' });
    d.dispose();
  });
});

test('fromHeaders()', async (t) => {
  await t.test('reads a Node.js headers object', () => {
    const d = Deadline.fromHeaders({ [DEFAULT_HEADER]: '1500' });
    assert.equal(d.budget, 1500);
    d.dispose();
  });
  await t.test('reads a WHATWG Headers instance', () => {
    const d = Deadline.fromHeaders(new Headers({ 'X-Request-Timeout-Ms': '700' }));
    assert.equal(d.budget, 700);
    d.dispose();
  });
  await t.test('caps the incoming value with max', () => {
    const d = Deadline.fromHeaders({ [DEFAULT_HEADER]: '60000' }, { max: 5000 });
    assert.equal(d.budget, 5000);
    d.dispose();
  });
  await t.test('uses the fallback when missing or invalid', () => {
    const a = Deadline.fromHeaders({}, { fallback: 3000 });
    const b = Deadline.fromHeaders({ [DEFAULT_HEADER]: 'soon' }, { fallback: 3000 });
    assert.equal(a.budget, 3000);
    assert.equal(b.budget, 3000);
    a.dispose();
    b.dispose();
  });
  await t.test('returns null with no header and no fallback', () => {
    assert.equal(Deadline.fromHeaders({}), null);
    assert.equal(Deadline.fromHeaders(undefined), null);
  });
  await t.test('honours a custom header', () => {
    const d = Deadline.fromHeaders({ 'x-budget': '42' }, { header: 'X-Budget' });
    assert.equal(d.budget, 42);
    assert.equal(d.header, 'X-Budget');
    d.dispose();
  });
  await t.test('validates fallback and max', () => {
    assert.throws(() => Deadline.fromHeaders({}, { fallback: -1 }), TypeError);
    assert.throws(() => Deadline.fromHeaders({}, { max: 'x' }), TypeError);
  });
});

test('child()', async (t) => {
  await t.test('gets the smaller of its own budget and what is left', () => {
    const clock = manualClock();
    const parent = new Deadline(1000, { clock });
    const small = parent.child(200);
    const capped = parent.child(5000);
    const all = parent.child();
    assert.equal(small.budget, 200);
    assert.equal(capped.budget, 1000);
    assert.equal(all.budget, 1000);
    [parent, small, capped, all].forEach((d) => d.dispose());
  });
  await t.test('subtracts the reserve', () => {
    const clock = manualClock();
    const parent = new Deadline(1000, { clock, reserve: 100 });
    const a = parent.child();
    const b = parent.child(Infinity, { reserve: 0 });
    assert.equal(a.budget, 900);
    assert.equal(b.budget, 1000);
    [parent, a, b].forEach((d) => d.dispose());
  });
  await t.test('is cancelled with the parent reason', () => {
    const parent = new Deadline(1000);
    const child = parent.child(500);
    const reason = new CancelledError('client left');
    parent.cancel(reason);
    assert.equal(child.signal.reason, reason);
  });
  await t.test('starts aborted if the parent already is', () => {
    const parent = new Deadline(0);
    const child = parent.child(500);
    assert.equal(child.signal.aborted, true);
    assert.ok(child.signal.reason instanceof DeadlineExceededError);
  });
  await t.test('cancelling the child leaves the parent alone', () => {
    const parent = new Deadline(1000);
    const child = parent.child(500);
    child.cancel();
    assert.equal(parent.signal.aborted, false);
    parent.dispose();
  });
  await t.test('validates its budget', () => {
    const parent = new Deadline(1000);
    assert.throws(() => parent.child(-1), TypeError);
    assert.throws(() => parent.child(10, { reserve: -1 }), TypeError);
    parent.dispose();
  });
});

test('race()', async (t) => {
  await t.test('resolves when the task wins', async () => {
    const d = new Deadline(1000);
    assert.equal(await d.race(Promise.resolve('done')), 'done');
    d.dispose();
  });
  await t.test('rejects with DeadlineExceededError when time runs out', async () => {
    const d = new Deadline(20);
    await assert.rejects(d.race(sleep(200)), DeadlineExceededError);
  });
  await t.test('passes the signal to a task function', async () => {
    const d = new Deadline(1000);
    let received;
    await d.race(async (signal) => {
      received = signal;
    });
    assert.equal(received, d.signal);
    d.dispose();
  });
  await t.test('rejects immediately when already expired', async () => {
    const d = new Deadline(0);
    let called = false;
    await assert.rejects(
      d.race(() => {
        called = true;
      }),
      DeadlineExceededError
    );
    assert.equal(called, false);
  });
  await t.test('propagates task errors', async () => {
    const d = new Deadline(1000);
    await assert.rejects(d.race(Promise.reject(new Error('db down'))), /db down/);
    d.dispose();
  });
});

test('fetch()', async (t) => {
  function recordingFetch(response = new Response('ok')) {
    const calls = [];
    const impl = async (input, init) => {
      calls.push({ input, init });
      return response;
    };
    impl.calls = calls;
    return impl;
  }

  await t.test('forwards the remaining budget minus reserve', async () => {
    const clock = manualClock();
    const fetchImpl = recordingFetch();
    const d = new Deadline(1000, { clock, fetch: fetchImpl, reserve: 50 });
    clock.advance(200);
    await d.fetch('http://svc/b', { headers: { accept: 'application/json' } });
    const { init } = fetchImpl.calls[0];
    assert.equal(init.headers.get(DEFAULT_HEADER), '750');
    assert.equal(init.headers.get('accept'), 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    d.dispose();
  });
  await t.test('per-call reserve overrides the default', async () => {
    const clock = manualClock();
    const fetchImpl = recordingFetch();
    const d = new Deadline(1000, { clock, fetch: fetchImpl, reserve: 50 });
    await d.fetch('http://svc', {}, { reserve: 0 });
    assert.equal(fetchImpl.calls[0].init.headers.get(DEFAULT_HEADER), '1000');
    d.dispose();
  });
  await t.test('does not send a request when no budget is left', async () => {
    const clock = manualClock();
    const fetchImpl = recordingFetch();
    const d = new Deadline(100, { clock, fetch: fetchImpl, reserve: 100 });
    await assert.rejects(d.fetch('http://svc'), DeadlineExceededError);
    clock.advance(100);
    await assert.rejects(d.fetch('http://svc', {}, { reserve: 0 }), DeadlineExceededError);
    assert.equal(fetchImpl.calls.length, 0);
    d.dispose();
  });
  await t.test('rejects with the deadline reason when aborted mid-flight', async () => {
    const hanging = (input, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const d = new Deadline(20, { fetch: hanging });
    await assert.rejects(d.fetch('http://svc'), DeadlineExceededError);
  });
  await t.test("respects the caller's own signal", async () => {
    const hanging = (input, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const d = new Deadline(1000, { fetch: hanging });
    const own = new AbortController();
    const pending = d.fetch('http://svc', { signal: own.signal });
    own.abort(new Error('user clicked cancel'));
    await assert.rejects(pending, /user clicked cancel/);
    assert.equal(d.signal.aborted, false);
    d.dispose();
  });
  await t.test('aborts immediately if the caller signal is already aborted', async () => {
    let seen;
    const d = new Deadline(1000, {
      fetch: async (input, init) => {
        seen = init.signal;
        throw init.signal.reason;
      },
    });
    await assert.rejects(d.fetch('http://svc', { signal: AbortSignal.abort(new Error('early')) }), /early/);
    assert.equal(seen.aborted, true);
    d.dispose();
  });
  await t.test('passes through non-abort errors', async () => {
    const d = new Deadline(1000, {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(d.fetch('http://svc'), /fetch failed/);
    d.dispose();
  });
  await t.test('errors clearly when no fetch is available', async (t2) => {
    const original = globalThis.fetch;
    t2.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = undefined;
    const d = new Deadline(1000);
    await assert.rejects(d.fetch('http://svc'), /No fetch implementation/);
    d.dispose();
  });
});

test('error classes', () => {
  const plain = new DeadlineExceededError();
  assert.equal(plain.message, 'Deadline exceeded');
  assert.equal(plain.budget, undefined);
  assert.ok(plain instanceof Error);
  assert.equal(new DeadlineExceededError(50).message, 'Deadline exceeded (budget was 50ms)');
  assert.equal(new CancelledError().message, 'Operation cancelled');
  assert.equal(new CancelledError('bye').message, 'bye');
});
