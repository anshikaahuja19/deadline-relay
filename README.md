# deadline-relay

[![npm version](https://img.shields.io/npm/v/deadline-relay.svg)](https://www.npmjs.com/package/deadline-relay)
[![CI](https://github.com/anshikaahuja19/deadline-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/anshikaahuja19/deadline-relay/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/deadline-relay.svg)](./LICENSE)

> Propagate request deadlines across HTTP services, so downstream work stops as soon as the caller has given up.

**GitHub:** [github.com/anshikaahuja19/deadline-relay](https://github.com/anshikaahuja19/deadline-relay) ·
**npm:** [npmjs.com/package/deadline-relay](https://www.npmjs.com/package/deadline-relay) ·
**Issues:** [report a bug](https://github.com/anshikaahuja19/deadline-relay/issues)

```js
const express = require('express');
const { deadline } = require('deadline-relay');

const app = express();
app.use(deadline({ timeout: 3000 }));

app.get('/checkout', async (req, res) => {
  // Sends the *remaining* budget downstream and aborts when it runs out.
  const stock = await req.deadline.fetch('http://inventory/stock');
  res.json(await stock.json());
});
```

---

## Table of contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Basic usage](#basic-usage)
- [API](#api)
  - [deadline(options?)](#deadlineoptions): middleware
  - [Deadline class](#deadline-class)
  - [Errors](#errors)
  - [Helpers and constants](#helpers-and-constants)
- [Examples](#examples)
- [Comparison with alternatives](#comparison-with-alternatives)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## The problem

In a system of services, one user request fans out into a chain of HTTP calls:

```
client ──3s──▶ gateway ──▶ orders ──▶ inventory
```

Each service usually sets its **own fixed timeout**, and none of them know how much time the caller has left. That causes two problems:

1. **Wasted work.** The client gives up after 3 s, but `orders` and `inventory` keep going, sometimes for 30 s or more. They run queries and hold connections for a response nobody will read. Under load this snowballs: retries pile on top of abandoned work.
2. **Wrong timeouts.** `inventory` might allow itself 10 s when only 200 ms of the client's budget is left.

gRPC solves this with **deadline propagation**: every call carries its remaining time, and every hop cancels its work when that time runs out. Plain HTTP and REST have nothing standard for this. **deadline-relay** adds it to Node.js HTTP services.

## How it works

1. The **middleware** gives each incoming request a `req.deadline`. The budget comes from the caller's `x-request-timeout-ms` header, or from your default.
2. `req.deadline.signal` is an `AbortSignal` that fires when the budget runs out or the client disconnects. Pass it to anything cancellable: `fetch`, database drivers, `fs`, `child_process`, and so on.
3. `req.deadline.fetch()` calls the next service with the **remaining** budget in the header, minus an optional reserve. That service's middleware picks it up, and the deadline travels on down the chain.
4. When the budget runs out, the middleware replies `504 Gateway Timeout`, unless the handler has already started responding.

```
client ─(300ms)─▶ gateway ─(279ms)─▶ orders ─(207ms)─▶ inventory
                                                          │ stops at 207ms
client ◀────────── 504 after ~290ms ◀─────────────────────┘ (not 1000ms)
```

Budgets are sent as **relative milliseconds** ("2500ms left"), not absolute timestamps, so clock differences between machines don't matter, which is the same design gRPC uses.

## Installation

```bash
npm install deadline-relay
```

Requires Node.js 18 or newer. There are no dependencies. It works with Express, Connect and plain `node:http`, and with both `require` and `import`:

```js
const { deadline, Deadline } = require('deadline-relay'); // CommonJS
import { deadline, Deadline } from 'deadline-relay'; // ES modules
```

## Basic usage

**Express**

```js
const { deadline, DeadlineExceededError } = require('deadline-relay');

app.use(deadline({ timeout: 5000, max: 10000, reserve: 50 }));

app.get('/report', async (req, res, next) => {
  try {
    const data = await req.deadline.fetch('http://analytics/summary'); // forwards the budget
    const rows = await db.query(sql, { signal: req.deadline.signal }); // cancellable driver
    const pdf = await req.deadline.race(renderPdf(rows)); // bound any promise
    res.send(pdf);
  } catch (err) {
    if (err instanceof DeadlineExceededError) return; // 504 already sent
    next(err);
  }
});
```

**Plain `node:http`**

```js
const http = require('node:http');
const { deadline } = require('deadline-relay');

const withDeadline = deadline({ timeout: 2000 });

http
  .createServer((req, res) => {
    withDeadline(req, res, () => {
      res.end(`You have ${req.deadline.remaining()}ms`);
    });
  })
  .listen(3000);
```

**Calling a deadline-aware service from a client.** Just send the header:

```bash
curl -H "x-request-timeout-ms: 800" http://localhost:3000/report
```

## API

### `deadline(options?)`

Creates the middleware. It works with Express, Connect, and anything else that uses `(req, res, next)`.

**Parameters**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `timeout` | `number` | `10000` | Budget in ms when the caller sends no valid header. |
| `max` | `number` | none | Upper limit on any budget, so a caller can't ask for an hour. |
| `header` | `string` | `'x-request-timeout-ms'` | Header to read, and to forward with `req.deadline.fetch()`. |
| `reserve` | `number` | `0` | Ms held back when forwarding, so this service still has time to reply after a downstream call times out. |
| `trustIncoming` | `boolean` | `true` | Set to `false` on public edges to ignore the caller's header and always use `timeout`. |
| `onExpired` | `(req, res, error) => void` | sends a 504 | Called when the budget runs out. The default sends `504` with a JSON body, unless headers were already sent. |

**Returns:** a middleware function `(req, res, next) => void`.

**Behaviour**

- Sets `req.deadline` to a [`Deadline`](#deadline-class).
- If the incoming budget is `0`, it calls `onExpired` straight away and **skips your handler**.
- When the response finishes, it clears the timer. Nothing leaks, and nothing fires after a fast response.
- If the client disconnects before the response finishes, it cancels `req.deadline` with a `CancelledError`, so your work stops too.

Default 504 body:

```json
{ "error": "Gateway Timeout", "code": "DEADLINE_EXCEEDED", "message": "Deadline exceeded (budget was 300ms)" }
```

### `Deadline` class

You can also use it on its own, for background jobs, scripts, or queue workers.

#### `new Deadline(budget, options?)`

| Parameter | Type | Description |
| --- | --- | --- |
| `budget` | `number` | Ms from now until the deadline. Values above `MAX_BUDGET` (~24.8 days) are capped. |
| `options.reserve` | `number` | Default reserve for `fetch()`, `toHeaders()` and `child()`. Defaults to `0`. |
| `options.header` | `string` | Header name for `fetch()` and `toHeaders()`. |
| `options.parent` | `Deadline` | Cancel this deadline when the parent is cancelled or expires. |
| `options.fetch` | `function` | A custom `fetch` implementation. Defaults to the global `fetch`. |

#### Properties and methods

| Member | Returns | Description |
| --- | --- | --- |
| `.signal` | `AbortSignal` | Aborts when the deadline expires (reason: `DeadlineExceededError`) or is cancelled (reason: `CancelledError` or your own). |
| `.budget` | `number` | The original budget in ms. |
| `.expired` | `boolean` | `true` once time is up or the deadline was cancelled. |
| `.remaining()` | `number` | Whole ms left. `0` once expired or cancelled. |
| `.fetch(input, init?, { reserve? })` | `Promise<Response>` | `fetch` with the remaining budget (minus `reserve`) in the header, plus a linked abort signal. Rejects with `DeadlineExceededError` **without sending anything** if there's no budget left. Your own `init.signal` still works. |
| `.race(promiseOrFn)` | `Promise<T>` | Resolves with the task's result, or rejects with the abort reason when the deadline fires first. If you pass a function, it receives `signal`. |
| `.child(budget?, { reserve? })` | `Deadline` | A sub-deadline with the smaller of `budget` and the time left (minus `reserve`). It is cancelled together with the parent. |
| `.toHeaders({ reserve? })` | `object` | `{ 'x-request-timeout-ms': '<ms>' }`, for HTTP clients other than `fetch` (axios, got, undici). |
| `.throwIfExpired()` | `void` | Throws the abort reason if the deadline has expired. Use it as a checkpoint inside loops. |
| `.cancel(reason?)` | `void` | Aborts now. Defaults to a `CancelledError`. Calling it more than once is safe. |
| `.dispose()` | `void` | Stops the timer without aborting. Use it when the work finished early. |

#### `Deadline.fromHeaders(headers, options?)`

Builds a deadline from incoming headers. `headers` can be Node's `req.headers` or a WHATWG `Headers` object.

| Option | Description |
| --- | --- |
| `fallback` | Budget to use when the header is missing or invalid. |
| `max` | Upper limit on the incoming value. |
| other options | Passed on to `new Deadline()`. |

**Returns:** a `Deadline`, or `null` when there's no header and no `fallback`.

```js
// e.g. in a queue consumer that receives HTTP-style headers
const d = Deadline.fromHeaders(message.headers, { fallback: 30000, max: 60000 });
```

#### Examples

```js
const { Deadline } = require('deadline-relay');

const job = new Deadline(5000);

await job.child(1000).race(downloadFile()); // at most 1s of the 5s
await job.race((signal) => fetch(url, { signal })); // the rest

for (const row of rows) {
  job.throwIfExpired(); // stop between items, not mid-write
  await save(row);
}

axios.get(url, { headers: job.toHeaders({ reserve: 100 }), signal: job.signal });
job.dispose();
```

### Errors

Both error classes extend `Error` and have a `code` property you can check across package versions.

| Class | `code` | When |
| --- | --- | --- |
| `DeadlineExceededError` | `'DEADLINE_EXCEEDED'` | The budget ran out. It has a `budget` property. |
| `CancelledError` | `'CANCELLED'` | The client disconnected, `cancel()` was called, or a parent deadline was cancelled. |

### Helpers and constants

| Export | Description |
| --- | --- |
| `parseBudget(value)` | Parses a header value into ms. Only accepts non-negative integers. Returns `undefined` for anything else (`'2s'`, `'-1'`, `'1.5'`). |
| `respondGatewayTimeout(req, res, error)` | The default `onExpired`. Useful if you want to wrap it, e.g. to add logging. |
| `DEFAULT_HEADER` | `'x-request-timeout-ms'` |
| `MAX_BUDGET` | `2147483647`, the largest delay `setTimeout` supports. |

## Examples

| File | Shows |
| --- | --- |
| [`examples/microservices.js`](./examples/microservices.js) | Three local services. The budget shrinks at each hop and the slow one stops early. Run it with `npm run example`. |
| [`examples/express-app.js`](./examples/express-app.js) | An Express app using `fetch`, `race` and error handling. Needs `npm install express`. |
| [`examples/background-job.js`](./examples/background-job.js) | Splitting one budget across steps with `child()`, with no HTTP involved |

Output of `npm run example`:

```
[gateway  ] received budget 300ms
[orders   ] received budget 279ms
[inventory] received budget 207ms (needs 1000ms)
[inventory] stopped early: Deadline exceeded (budget was 207ms)

[client   ] HTTP 504 after 289ms
```

## Comparison with alternatives

| | deadline-relay | `connect-timeout` | `AbortSignal.timeout()` | gRPC deadlines |
| --- | :-: | :-: | :-: | :-: |
| Per-request timeout in Express/HTTP | ✅ | ✅ | ❌ (manual) | n/a |
| Passes the **remaining** budget to downstream HTTP calls | ✅ | ❌ | ❌ | ✅ (gRPC only) |
| Honours the caller's budget | ✅ | ❌ | ❌ | ✅ |
| `AbortSignal` to cancel your own work | ✅ | ❌ | ✅ | ✅ |
| Cancels work when the client disconnects | ✅ | ❌ | ❌ | ✅ |
| Sub-budgets for individual steps | ✅ | ❌ | ❌ | ❌ |

## Limitations

- **Cancellation is cooperative.** JavaScript can't kill a running function. Work stops only where you pass `signal`, use `race()`/`fetch()`, or call `throwIfExpired()`. Code that ignores these keeps running in the background, even though the caller has already received a 504.
- **Don't respond after a 504.** Once the middleware has replied, writing to `res` again throws `ERR_HTTP_HEADERS_SENT`. Check `req.deadline.expired`, or catch `DeadlineExceededError`, before you respond.
- **A downstream 504 is a normal response.** If the downstream service runs out of time first (it usually does, since it got a smaller budget), `req.deadline.fetch()` *resolves* with that service's `504` response; it rejects with `DeadlineExceededError` only when *your* deadline fires first. Check `response.status` as you would with plain `fetch`. Setting a `reserve` gives you time to reply after the downstream gives up.
- **Both sides must take part.** Downstream services need this middleware, or must read the header some other way, for the budget to keep travelling. Other services simply ignore the header.
- **The header is not a standard.** `x-request-timeout-ms` is a convention of this package. Use the `header` option to match an existing convention in your system.
- **Trust at the edge.** A public client can send any budget. Use `max`, or `trustIncoming: false`, on internet-facing services.
- **Millisecond resolution**, with budgets capped at ~24.8 days.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions and the release process. In short:

```bash
git clone https://github.com/anshikaahuja19/deadline-relay.git
cd deadline-relay
npm test
```

Please [open an issue](https://github.com/anshikaahuja19/deadline-relay/issues) before starting a large change.

## License

[MIT](./LICENSE)
