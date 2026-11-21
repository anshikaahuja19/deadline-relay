'use strict';

// Using deadline-relay with Express (install it first: npm install express).
//
//   node examples/express-app.js
//   curl -H "x-request-timeout-ms: 500" http://localhost:3000/report

const express = require('express');
const { deadline, DeadlineExceededError } = require('../src');

const app = express();

// Every request gets req.deadline. Callers may send a smaller budget;
// nobody may ask for more than 5 seconds.
app.use(deadline({ timeout: 3000, max: 5000, reserve: 50 }));

app.get('/report', async (req, res, next) => {
  try {
    // Pass the remaining budget to the next service automatically.
    const users = await req.deadline.fetch('https://jsonplaceholder.typicode.com/users');

    // Bound any other promise (DB query, cache, file read) by the same deadline.
    const summary = await req.deadline.race(buildSummary(await users.json()));

    res.json({ summary, msLeft: req.deadline.remaining() });
  } catch (err) {
    // The middleware has already sent the 504; nothing more to do.
    if (err instanceof DeadlineExceededError) return;
    next(err);
  }
});

async function buildSummary(users) {
  return { count: users.length };
}

app.listen(3000, () => console.log('Listening on http://localhost:3000/report'));
