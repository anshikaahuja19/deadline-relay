'use strict';

// Three services on localhost: gateway -> orders -> inventory.
// The client gives the gateway a 300ms budget; inventory needs 1000ms.
//
//   npm run example
//
// Watch the budget shrink at each hop and every service stop early,
// instead of inventory doing a full second of work nobody will receive.

const http = require('node:http');
const { deadline, DEFAULT_HEADER } = require('../src');

const log = (service, msg) => console.log(`[${service.padEnd(9)}] ${msg}`);

function start(name, port, handler) {
  const mw = deadline({ timeout: 2000, reserve: 20 });
  const server = http.createServer((req, res) => mw(req, res, () => handler(req, res)));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const servers = await Promise.all([
    start('gateway', 4001, async (req, res) => {
      log('gateway', `received budget ${req.deadline.budget}ms`);
      try {
        const r = await req.deadline.fetch('http://127.0.0.1:4002/orders');
        res.statusCode = r.status; // pass a downstream 504 back up
        res.end(await r.text());
      } catch (err) {
        log('gateway', `gave up: ${err.message}`);
      }
    }),

    start('orders', 4002, async (req, res) => {
      log('orders', `received budget ${req.deadline.budget}ms`);
      await new Promise((r) => setTimeout(r, 50)); // some local work
      try {
        const r = await req.deadline.fetch('http://127.0.0.1:4003/stock');
        res.statusCode = r.status; // pass a downstream 504 back up
        res.end(await r.text());
      } catch (err) {
        log('orders', `gave up: ${err.message}`);
      }
    }),

    start('inventory', 4003, (req, res) => {
      log('inventory', `received budget ${req.deadline.budget}ms (needs 1000ms)`);
      const work = setTimeout(() => {
        log('inventory', 'finished the slow query'); // never printed
        res.end('in stock');
      }, 1000);
      req.deadline.signal.addEventListener('abort', () => {
        clearTimeout(work);
        log('inventory', `stopped early: ${req.deadline.signal.reason.message}`);
      });
    }),
  ]);

  const started = Date.now();
  const res = await fetch('http://127.0.0.1:4001/', { headers: { [DEFAULT_HEADER]: '300' } });
  console.log(`\n[client   ] HTTP ${res.status} after ${Date.now() - started}ms: ${await res.text()}`);

  await new Promise((r) => setTimeout(r, 100));
  servers.forEach((s) => {
    s.closeAllConnections?.();
    s.close();
  });
}

main();
