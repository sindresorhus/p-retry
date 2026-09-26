import fs from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execa} from 'execa';
import {rejectsWith, temporaryScript} from './helpers.js';
import pRetry from './index.js';

// A regression test for the one exit from `onAttemptFailure` that had no abort check. The other
// seven are covered by the other suites; this is the branch where `shouldRetry` returns true, aborts,
// and spends the remaining budget, so the budget check is what used to report the operation failure.
test('a cancellation is final even when the budget runs out inside shouldRetry', async () => {
	const originalPerformanceNow = performance.now;
	let now = 0;

	// A controlled clock. With a real 40ms budget, a worker descheduled for longer than that exhausts
	// it before `shouldRetry` runs, so the abort never happens and the test passes without ever
	// reaching the branch it is about.
	performance.now = () => now;

	try {
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
					now += 80; // Longer than the whole budget.
					controller.abort(cancelled);
					return true;
				},
			}),
			rejectsWith(cancelled),
		);
	} finally {
		performance.now = originalPerformanceNow;
	}
});

// A `shouldConsumeRetry` that returns nothing must stay bounded. An in-process timeout cannot catch a
// regression here: the failure is a microtask loop that starves the event loop, so a timer-based
// timeout never fires and the file wedges instead of failing. A subprocess is killed from outside,
// so this reports a failure in seconds rather than hanging.
test('a shouldConsumeRetry that returns nothing is bounded, checked from outside', {timeout: 30_000}, async () => {
	const temporaryFile = await temporaryScript('p-retry-undefined-bounded.mjs', `
const controller = new AbortController();
let attempts = 0;

try {
	await pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 2,
		minTimeout: 0,
		signal: controller.signal,
		// A logging-only callback that forgets to return, so it resolves to undefined.
		async shouldConsumeRetry() {},
	});
} catch {
	console.log('attempts=' + attempts);
}
`);

	try {
		const {timedOut, stdout} = await execa('node', [temporaryFile], {timeout: 8000, reject: false});
		assert.equal(timedOut, false, 'the run must finish rather than loop forever');
		// Two retries means three attempts.
		assert.match(stdout, /attempts=3/v);
	} finally {
		await fs.unlink(temporaryFile);
	}
});
