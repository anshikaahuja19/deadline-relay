'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  deadline,
  Deadline,
  DeadlineExceededError,
  CancelledError,
  DEFAULT_HEADER,
} = require('../src');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a real HTTP server that runs the middleware and then `handler`.
 * Returns its base URL; the server is closed when the test ends.
 */
async function serve(t, middleware, handler) {
  const server = http.createServer((req, res) => {
    middleware(req, res, () => handler(req, res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('attaches req.deadline using the default timeout', async (t) => {
  let seen;
  const url = await serve(t, deadline({ timeout: 4000 }), (req, res) => {
    seen = req.deadline;
    res.end('ok');
  });
  await fetch(url);
  assert.ok(seen instanceof Deadline);
  assert.equal(seen.budget, 4000);
});

test("honours the caller's header", async (t) => {
  let budget;
  const url = await serve(t, deadline({ timeout: 4000 }), (req, res) => {
    budget = req.deadline.budget;
    res.end();
  });
  await fetch(url, { headers: { [DEFAULT_HEADER]: '1234' } });
  assert.equal(budget, 1234);
});

test('caps the caller with max', async (t) => {
  let budget;
  const url = await serve(t, deadline({ max: 500 }), (req, res) => {
    budget = req.deadline.budget;
    res.end();
  });
  await fetch(url, { headers: { [DEFAULT_HEADER]: '999999' } });
  assert.equal(budget, 500);
});

test('ignores the header when trustIncoming is false', async (t) => {
  let budget;
  const url = await serve(t, deadline({ timeout: 800, trustIncoming: false }), (req, res) => {
    budget = req.deadline.budget;
    res.end();
  });
  await fetch(url, { headers: { [DEFAULT_HEADER]: '5' } });
  assert.equal(budget, 800);
});

test('falls back to the default for an invalid header', async (t) => {
  let budget;
  const url = await serve(t, deadline({ timeout: 800 }), (req, res) => {
    budget = req.deadline.budget;
    res.end();
  });
  await fetch(url, { headers: { [DEFAULT_HEADER]: 'later' } });
  assert.equal(budget, 800);
});

test('supports a custom header name', async (t) => {
  let budget;
  const url = await serve(t, deadline({ header: 'X-Budget-Ms' }), (req, res) => {
    budget = req.deadline.budget;
    res.end();
  });
  await fetch(url, { headers: { 'x-budget-ms': '321' } });
  assert.equal(budget, 321);
});

test('responds 504 when the handler is too slow', async (t) => {
  let abortedReason;
  const url = await serve(t, deadline({ timeout: 30 }), (req) => {
    req.deadline.signal.addEventListener('abort', () => {
      abortedReason = req.deadline.signal.reason;
    });
    // never responds
  });
  const res = await fetch(url);
  assert.equal(res.status, 504);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), {
    error: 'Gateway Timeout',
    code: 'DEADLINE_EXCEEDED',
    message: 'Deadline exceeded (budget was 30ms)',
  });
  assert.ok(abortedReason instanceof DeadlineExceededError);
});

test('responds 504 immediately for a zero budget and skips the handler', async (t) => {
  let called = false;
  const url = await serve(t, deadline(), (req, res) => {
    called = true;
    res.end();
  });
  const res = await fetch(url, { headers: { [DEFAULT_HEADER]: '0' } });
  assert.equal(res.status, 504);
  assert.equal(called, false);
});

test('does not interfere with responses that finish in time', async (t) => {
  let signal;
  const url = await serve(t, deadline({ timeout: 40 }), (req, res) => {
    signal = req.deadline.signal;
    res.end('fast');
  });
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'fast');
  await sleep(70);
  assert.equal(signal.aborted, false, 'timer should be cleared after finish');
});

test('does not overwrite a response that already started', async (t) => {
  const url = await serve(t, deadline({ timeout: 30 }), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial ');
    setTimeout(() => res.end('done'), 60);
  });
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'partial done');
});

test('calls a custom onExpired', async (t) => {
  const url = await serve(
    t,
    deadline({
      timeout: 20,
      onExpired: (req, res, error) => {
        res.statusCode = 503;
        res.end(`custom:${error.code}`);
      },
    }),
    () => {}
  );
  const res = await fetch(url);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'custom:DEADLINE_EXCEEDED');
});

test('cancels the deadline when the client disconnects', async (t) => {
  let resolveReason;
  const reason = new Promise((resolve) => {
    resolveReason = resolve;
  });
  const url = await serve(t, deadline({ timeout: 5000 }), (req) => {
    req.deadline.signal.addEventListener('abort', () => resolveReason(req.deadline.signal.reason));
  });
  const client = new AbortController();
  const pending = fetch(url, { signal: client.signal }).catch(() => {});
  await sleep(30);
  client.abort();
  await pending;
  const r = await reason;
  assert.ok(r instanceof CancelledError);
  assert.equal(r.message, 'Client closed the connection');
});

test('propagates the remaining budget across services', async (t) => {
  // C records what it was given; B forwards via req.deadline.fetch().
  let budgetAtC;
  const urlC = await serve(t, deadline(), (req, res) => {
    budgetAtC = req.deadline.budget;
    res.end('from C');
  });
  const urlB = await serve(t, deadline({ reserve: 100 }), async (req, res) => {
    await sleep(50);
    const upstream = await req.deadline.fetch(urlC);
    res.end(`B got: ${await upstream.text()}`);
  });

  const res = await fetch(urlB, { headers: { [DEFAULT_HEADER]: '1000' } });
  assert.equal(await res.text(), 'B got: from C');
  // 1000 - ~50ms of work - 100 reserve, allowing some scheduling slack.
  assert.ok(budgetAtC <= 850 && budgetAtC >= 750, `budget at C was ${budgetAtC}`);
});

test('a slow downstream call is abandoned when the budget runs out', async (t) => {
  let cAborted = false;
  const urlC = await serve(t, deadline(), (req, res) => {
    req.deadline.signal.addEventListener('abort', () => {
      cAborted = true;
    });
    setTimeout(() => res.end('too late'), 500);
  });
  let errorAtB;
  const urlB = await serve(t, deadline({ timeout: 80 }), async (req, res) => {
    try {
      await req.deadline.fetch(urlC);
    } catch (err) {
      errorAtB = err;
    }
  });
  const started = Date.now();
  const res = await fetch(urlB);
  assert.equal(res.status, 504);
  assert.ok(Date.now() - started < 400, 'should not wait for C');
  assert.ok(errorAtB instanceof DeadlineExceededError);
  await sleep(50);
  assert.equal(cAborted, true, 'C should notice that its caller gave up');
});

test('validates options', () => {
  assert.throws(() => deadline({ timeout: -1 }), /timeout must be/);
  assert.throws(() => deadline({ max: 'x' }), /max must be/);
  assert.throws(() => deadline({ reserve: NaN }), /reserve must be/);
  assert.throws(() => deadline({ onExpired: 'nope' }), /onExpired must be a function/);
});
