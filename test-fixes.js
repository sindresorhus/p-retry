import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import {fixtureError, rejectsWith} from './helpers.js';
import pRetry from './index.js';

// A regression test for the one exit from `onAttemptFailure` that had no abort check. The other
// seven are covered by the other suites; this is the branch where `shouldRetry` returns true, aborts,
// and spends the remaining budget, so the budget check is what used to report the operation failure.
test('a cancellation is final even when the budget runs out inside shouldRetry', async () => {
	const controller = new AbortController();
	const cancelled = new Error('user cancelled');

	await assert.rejects(
		pRetry(async () => {
			throw new Error('operation failed');
		}, {
			signal: controller.signal,
			retries: 5,
			minTimeout: 0,
			maxRetryTime: 40,
			async shouldRetry() {
				await delay(80); // Longer than the whole budget.
				controller.abort(cancelled);
				return true;
			},
		}),
		rejectsWith(cancelled),
	);
});

// `instanceof` reads `getPrototypeOf`, which a proxy can make throw. This one answers the first read
// so the value is recognised as an error, then throws, so a type check further in used to turn into
// the reported failure. The value is not a `TypeError` as far as the check can tell, so it is retried
// rather than short-circuited, but never reported as the proxy's own trap.
test('a value that throws from getPrototypeOf later is not reported as the failure', async () => {
	let reads = 0;
	const hostile = new Proxy(new TypeError('x is not a function'), {
		getPrototypeOf() {
			if (++reads > 1) {
				throw new Error('getPrototypeOf exploded');
			}

			return TypeError.prototype;
		},
	});

	let rejection;

	try {
		await pRetry(async () => {
			throw hostile;
		}, {retries: 1, minTimeout: 0});
	} catch (error_) {
		rejection = error_;
	}

	assert.ok(rejection instanceof Error, 'pRetry rejects with an error');
	assert.notEqual(rejection.message, 'getPrototypeOf exploded');
});

test('the same value without a throwing trap is still a non-network TypeError', async () => {
	// The control for the test above: an ordinary cross-realm TypeError must still stop the retries.
	const typeError = new TypeError('x is not a function');
	let attempts = 0;

	await assert.rejects(
		pRetry(async () => {
			attempts++;
			throw typeError;
		}, {retries: 5, minTimeout: 0}),
		rejectsWith(typeError),
	);

	assert.equal(attempts, 1);
	assert.notEqual(fixtureError, typeError);
});
