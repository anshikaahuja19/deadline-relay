'use strict';

// Deadline works without HTTP too: here a job has 250ms in total
// and splits it between steps with child().
//
//   node examples/background-job.js

const { Deadline, DeadlineExceededError } = require('../src');

const step = (name, ms) => (signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(name), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

async function main() {
  const job = new Deadline(250);

  try {
    // Step 1 may use at most 100ms of the overall budget.
    console.log('done:', await job.child(100).race(step('fetch data', 60)));
    console.log(`left: ${job.remaining()}ms`);

    // Step 2 gets whatever is left, and is too slow.
    console.log('done:', await job.child().race(step('render pdf', 400)));
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      console.log(`stopped: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    job.dispose();
  }
}

main();
