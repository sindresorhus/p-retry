import fs from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execa} from 'execa';
import delay from 'delay';
import {
	fixture,
	fixtureError,
	rejectsWith,
	temporaryScript,
	captureDelays,
} from './helpers.js';
import pRetry, {AbortError} from './index.js';

test('handles async shouldRetry with maxRetryTime', async t => {
	const originalPerformanceNow = performance.now;
	const originalSetTimeout = setTimeout;
	const delays = [];
	let now = 0;

	// Both clocks are controlled. With real ones the callback's wait has to fit inside the budget for
	// a delay to be scheduled at all, which is a real time dependency with nothing behind it.
	performance.now = () => now;
	globalThis.setTimeout = (function_, ms) => {
		delays.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		performance.now = originalPerformanceNow;
		globalThis.setTimeout = originalSetTimeout;
	});

	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{
			retries: 10,
			maxRetryTime: 1000,
			async shouldRetry() {
				now += 100; // The callback is what spends the budget.
				return true;
			},
		},
	));

	// Each attempt costs 100ms of a 1000ms budget inside the callback, so the tenth attempt finds
	// nothing left. Were the callback time not counted, the backoff would schedule 1000, 2000, 4000
	// and the run would use all 11 attempts.
	assert.equal(attempts, 10);
	assert.deepEqual(delays, [900, 800, 700, 600, 500, 400, 300, 200, 100]);
});

test('onFailedAttempt can return a promise to add a delay', {timeout: 30_000}, async t => {
	const waitFor = 100;
	const delays = captureDelays(t);
	let isCalled;

	await pRetry(
		async () => {
			if (isCalled) {
				return fixture;
			}

			isCalled = true;
			throw fixtureError;
		},
		{
			async onFailedAttempt() {
				await delay(waitFor);
			},
		},
	);

	// The callback's own wait comes first, so the retry was only scheduled once it had resolved.
	assert.deepEqual(delays, [waitFor, 1000]);
});

test('factor affects exponential backoff', async t => {
	// Stronger test: capture actual scheduled delays via mocked setTimeout
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0); // Execute immediately to avoid slowing tests
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 2,
			minTimeout: 100,
			maxTimeout: Infinity,
			randomize: false,
		},
	));

	assert.deepEqual(captured, [100, 200, 400]);
});

test('timeouts are incremental with factor', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 0.5,
			minTimeout: 100,
			maxTimeout: Infinity,
			randomize: false,
		},
	));

	// With factor 0.5 and minTimeout 100, expected delays: 100, 50, 25 (before rounding)
	assert.deepEqual(captured, [100, 50, 25]);
});

test('setTimeout is never called with 0 minTimeout', async t => {
	let isCalled = false;
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = function_ => {
		isCalled = true;
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 0.5,
			minTimeout: 0,
			maxTimeout: Infinity,
			randomize: false,
		},
	));

	assert.equal(isCalled, false);
});

test('maxRetryTime uses monotonic clock', async t => {
	const originalDateNow = Date.now;
	const originalPerformanceNow = performance.now;

	let simulatedDateNow = 0;
	Date.now = () => simulatedDateNow;

	let simulatedMonotonicTimestamp = 0;
	performance.now = () => simulatedMonotonicTimestamp;

	t.after(() => {
		Date.now = originalDateNow;
		performance.now = originalPerformanceNow;
	});

	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			simulatedMonotonicTimestamp += 60;
			simulatedDateNow += attempts === 2 ? -1000 : 60;
			throw new Error('fail');
		},
		{
			maxRetryTime: 100,
			minTimeout: 0,
			retries: 5,
		},
	), {message: 'fail'});

	// The wall clock jumps a second backwards on the second attempt. A monotonic clock ignores that
	// and gives up once the simulated 120ms is past the 100ms budget, so the run stops at two.
	assert.equal(attempts, 2);
});

test('minTimeout is respected even with small factor', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 2,
			factor: 0.1,
			minTimeout: 100,
			maxTimeout: Infinity,
			randomize: false,
		},
	));

	// First delay is at least minTimeout. Second is minTimeout * 0.1 = 10
	assert.deepEqual(captured, [100, 10]);
});

test('maxTimeout caps retry delays', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			minTimeout: 100,
			factor: 3,
			maxTimeout: 150,
			randomize: false,
		},
	));

	assert.deepEqual(captured, [100, 150, 150]);
});

test('skipped attempts do not impact backoff', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0, ...arguments_);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;

			if (attempts === 1) {
				throw new Error('skip');
			}

			throw new Error('fail');
		},
		{
			retries: 3,
			factor: 2,
			minTimeout: 100,
			maxTimeout: Infinity,
			randomize: false,
			shouldConsumeRetry: ({error}) => error.message !== 'skip',
		},
	));

	// Skip should not shift the backoff sequence; it simply retries without consuming budget.
	assert.deepEqual(captured, [100, 200, 400]);
	// One skipped attempt plus three counted retries, plus the final failure.
	assert.equal(attempts, 5);
});

test('shouldConsumeRetry time counts toward maxRetryTime', {timeout: 30_000}, async t => {
	let attempts = 0;
	const delays = captureDelays(t);
	const maxRetryTime = 200;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			throw new Error('fail');
		},
		{
			maxRetryTime,
			minTimeout: 0,
			async shouldConsumeRetry() {
				await delay(300);
				return true;
			},
		},
	), {message: 'fail'});

	assert.equal(attempts, 1);
	// The only wait is the callback's own 300ms, so p-retry scheduled no retry delay at all.
	assert.deepEqual(delays, [300]);
});

test('delays are clamped to the setTimeout maximum', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	// A delay this large does not fit in a 32-bit integer, so `setTimeout` would fire it right away.
	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 2 ** 31,
		maxTimeout: Infinity,
	}));

	assert.deepEqual(captured, [(2 ** 31) - 1]);
});

test('delays stay 0 when minTimeout is 0 and the factor overflows', async t => {
	// The factor grows to `Infinity` after enough attempts, and `0 * Infinity` is `NaN`.
	const retryDelays = [];
	const scheduledDelays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		scheduledDelays.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 1030,
		minTimeout: 0,
		factor: 2,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}));

	assert.equal(retryDelays.length, 1031);
	assert.ok(retryDelays.every(value => !Number.isNaN(value)));
	assert.ok(scheduledDelays.every(value => !Number.isNaN(value)));
});

test('maxTimeout lower than minTimeout caps delay', async t => {
	// Assert the scheduled delay instead of wall clock time, which is unreliable under load.
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 200,
		maxTimeout: 50,
		factor: 1,
	}));

	// Capped by `maxTimeout`, so the single delay is 50ms and not `minTimeout` (200ms).
	assert.deepEqual(captured, [50]);
});

test('randomize affects retry delays', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	const originalRandom = Math.random;
	let calls = 0;
	const sequence = [0, 1, 0.5]; // → factors 1x, 2x, 1.5x

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	Math.random = () => sequence[calls++] ?? 0;

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
		Math.random = originalRandom;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			minTimeout: 100,
			factor: 1,
			randomize: true,
		},
	));

	assert.deepEqual(captured, [100, 200, 150]);
});

test('maxRetryTime limits total retry duration', {timeout: 30_000}, async t => {
	const delays = captureDelays(t);
	const maxRetryTime = 1000;

	await assert.rejects(pRetry(
		async () => {
			await delay(400);
			throw new Error('test');
		},
		{
			retries: 10,
			minTimeout: 100,
			maxRetryTime,
		},
	));

	// Every wait is trimmed to what is left of the budget, so none of them can run past it.
	for (const wait of delays) {
		assert.ok(wait > 0, `${wait} is a real wait`);
		assert.ok(wait <= maxRetryTime, `${wait} is within the retry budget`);
	}
});

test('onFailedAttempt time counts toward maxRetryTime', {timeout: 30_000}, async t => {
	let attempts = 0;
	const delays = captureDelays(t);
	const maxRetryTime = 200;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			throw new Error('fail');
		},
		{
			maxRetryTime,
			minTimeout: 0,
			async onFailedAttempt() {
				await delay(300);
			},
		},
	), {message: 'fail'});

	assert.equal(attempts, 1);
	// The only wait is the callback's own 300ms, so p-retry scheduled no retry delay at all.
	assert.deepEqual(delays, [300]);
});

test('signal already aborted when entering delay phase cancels immediately', {timeout: 10_000}, async t => {
	const controller = new AbortController();
	const delays = captureDelays(t);

	// Signal aborts before entering the delay phase (e.g., during input function execution)
	await assert.rejects(pRetry(async () => {
		controller.abort(fixtureError);
		throw new Error('input failed');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 5000, // Long delay to verify we don't wait
	}), rejectsWith(fixtureError));

	// The 5 second delay was never scheduled, so there was nothing to wait out.
	assert.deepEqual(delays, []);
});

test('signal abort during delay cancels promptly', {timeout: 20_000}, async t => {
	const controller = new AbortController();

	// Abort shortly after the first failure schedules its delay. Set up before the mock, so only
	// p-retry's own waits are recorded.
	setTimeout(() => controller.abort(fixtureError), 50);

	const delays = captureDelays(t);

	await assert.rejects(pRetry(async () => {
		throw new Error('retry');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 500,
		factor: 2,
	}), rejectsWith(fixtureError));

	// The 500ms delay was cleared when the abort landed, so the second retry never happened.
	assert.deepEqual(delays, [500]);
});

test('factor <= 0 is treated as 1 (stable delays)', {timeout: 30_000}, async t => {
	const delays = captureDelays(t);
	let calls = 0;

	await assert.rejects(pRetry(async () => {
		calls++;
		throw new Error('retry');
	}, {
		retries: 3,
		minTimeout: 100,
		factor: 0,
		// Make delays deterministic
		randomize: false,
	}));

	// A factor of 0 would otherwise give 100 on the first retry and 0 on every one after it.
	// The final attempt fails with nothing left to retry, so it never schedules a delay.
	assert.deepEqual(delays, [100, 100, 100]);
	assert.equal(calls, 4);
});

test('unref option prevents timeout from keeping process alive', {timeout: 30_000}, async t => {
	let isTimeoutUnrefCalled = false;

	// Mock setTimeout to track unref calls
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		const timeout = originalSetTimeout(function_, ms);
		timeout.unref = () => {
			isTimeoutUnrefCalled = true;
			return timeout;
		};

		return timeout;
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 2,
		minTimeout: 50,
		unref: true,
	}));

	assert.ok(isTimeoutUnrefCalled, 'timeout.unref() should be called when unref option is true');
});

test('unref option handles missing unref gracefully', {timeout: 30_000}, async t => {
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		const id = originalSetTimeout(function_, ms);
		return Number(id); // No `unref` property
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {retries: 1, minTimeout: 10, unref: true}));
});

test('preserves user stack trace through async retries', {timeout: 30_000}, async () => {
	const temporaryFile = await temporaryScript('p-retry-stack-test.mjs', `
async function foo1() {
	return await foo2();
}

async function foo2() {
	return await pRetry(
		async () => {
			throw new Error('foo2 failed');
		},
		{
			retries: 1,
		}
	);
}

async function main() {
	try {
		await foo1();
	} catch (error) {
		console.error('STACKTRACE_START');
		console.error(error.stack);
		console.error('STACKTRACE_END');
	}
}

main();
`);

	try {
		const {stderr, stdout} = await execa('node', [temporaryFile], {timeout: 20_000, reject: false});
		const output = stderr + stdout;
		const stack = output.split('STACKTRACE_START', 2)[1]?.split('STACKTRACE_END', 1)[0]?.trim();

		assert.ok(stack, 'Should capture stack trace output');

		assert.match(stack, /Error: foo2 failed/v);

		// Print the stack for debugging if needed
		if (!/foo2/v.test(stack) || !/foo1/v.test(stack) || !/main/v.test(stack)) {
			console.log('\n==== Full stack trace for debugging ====\n' + stack + '\n==== End stack trace ====\n');
		}

		assert.match(stack, /foo2/v);
		assert.match(stack, /foo1/v);
		assert.match(stack, /main/v);

		// Check order
		const lines = stack.split('\n');
		const foo2Index = lines.findIndex(line => /foo2/v.test(line));
		const foo1Index = lines.findIndex(line => /foo1/v.test(line));
		const mainIndex = lines.findIndex(line => /main/v.test(line));

		assert.notStrictEqual(foo2Index, -1, 'foo2 should appear in the stack trace');
		assert.ok(foo1Index > foo2Index, 'foo1 should appear after foo2');
		assert.ok(mainIndex > foo1Index, 'main should appear after foo1');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test('retryDelay is provided in onFailedAttempt context', async t => {
	const retryDelays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, _ms) => originalSetTimeout(function_, 0);

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 2,
			minTimeout: 100,
			randomize: false,
			onFailedAttempt({retryDelay}) {
				retryDelays.push(retryDelay);
			},
		},
	));

	// Verify retryDelay follows exponential backoff formula, ending with 0 when no retry remains
	assert.deepEqual(retryDelays, [100, 200, 400, 0]);
});

test('Only consumed retries advance backoff', async t => {
	let attempts = 0;
	const timeouts = [];
	const maxAttempts = 4;
	const minTimeout = 50;
	const factor = 2;
	const contexts = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		timeouts.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			attempts++;

			if (attempts === 1) {
				throw new Error('skip');
			}

			if (attempts === maxAttempts) {
				throw new AbortError('stop');
			}

			throw new Error('test');
		},
		{
			retries: 2,
			onFailedAttempt(context) {
				contexts.push(context);
			},
			shouldConsumeRetry({error}) {
				return error.message !== 'skip';
			},
			factor,
			minTimeout,
		},
	));

	assert.deepEqual(contexts.map(context => context.retriesConsumed), [0, 0, 1]);
	assert.deepEqual(contexts.map(context => context.retriesLeft), [2, 2, 1]);
	assert.deepEqual(timeouts, [minTimeout, minTimeout * factor]);
});

test('the delay is truncated to the time left', async t => {
	const originalPerformanceNow = performance.now;
	const originalSetTimeout = setTimeout;
	const captured = [];
	let now = 0;

	// Both clocks are controlled. With real ones, the first attempt has to complete inside the 100ms
	// budget for any delay to be scheduled at all, which leaves roughly 10ms of headroom before a
	// slow worker turns this into a zero-length run that asserts nothing.
	performance.now = () => now;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		performance.now = originalPerformanceNow;
		globalThis.setTimeout = originalSetTimeout;
	});

	// Each delay wants more than the whole budget, so each is trimmed to what is left, which shrinks
	// by the cost of the attempt in between.
	await assert.rejects(pRetry(async () => {
		now += 10;
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 1000,
		maxRetryTime: 100,
	}));

	assert.deepEqual(captured, [90, 80, 70]);
});

test('randomized delays stay within minTimeout and maxTimeout', {timeout: 30_000}, async t => {
	const originalRandom = Math.random;
	const retryDelays = [];

	// The multiplier is 1 + `Math.random()`, so this is just under 2.
	Math.random = () => 0.999;

	t.after(() => {
		Math.random = originalRandom;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 5,
		minTimeout: 100,
		factor: 2,
		maxTimeout: 300,
		randomize: true,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}));

	// 100 * ~2 is 200, then the doubling is capped at `maxTimeout`, and the last one has nothing left.
	assert.deepEqual(retryDelays, [200, 300, 300, 300, 300, 0]);
});

test('factor: 1 keeps the delay constant', {timeout: 30_000}, async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 1,
			minTimeout: 100,
			randomize: false,
		},
	));

	assert.deepEqual(captured, [100, 100, 100]);
});

test('maxTimeout: 0 retries without waiting', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 2,
			minTimeout: 100,
			maxTimeout: 0,
		},
	));

	assert.deepEqual(captured, []);
});

test('unref lets the process exit while a retry is pending', {timeout: 15_000}, async () => {
	// A real process, because the point is whether a pending timer keeps it alive.
	const temporaryFile = await temporaryScript('p-retry-unref-test.mjs', `
try {
	await pRetry(async () => {
		throw new Error('fail');
	}, {retries: 5, minTimeout: 60_000, unref: true});
} catch {}
`);

	try {
		// The pending delay is a minute, so this can only finish if \`unref\` did its job. The subprocess
		// timeout sits below this test's own, so a regression fails on the assertion rather than as a hang.
		const {timedOut} = await execa('node', [temporaryFile], {timeout: 8000, reject: false});
		assert.ok(!timedOut, 'the process should exit while a retry is pending');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test('aborting during a delay does not leave the timer running', {timeout: 15_000}, async () => {
	// A real process, because a timer that was never cleared is only visible as the process refusing
	// to exit. Nothing else in the suite can tell a cleared delay from one that still has 60s to run.
	const temporaryFile = await temporaryScript('p-retry-abort-timer-test.mjs', `
const controller = new AbortController();
setTimeout(() => {
	controller.abort(new Error('cancelled'));
}, 50);

try {
	await pRetry(async () => {
		throw new Error('fail');
	}, {signal: controller.signal, retries: 5, minTimeout: 60_000});
} catch {}
`);

	try {
		const {timedOut} = await execa('node', [temporaryFile], {timeout: 8000, reject: false});
		assert.ok(!timedOut, 'the abort should clear the pending delay');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test('unref is not applied unless the option is set', {timeout: 30_000}, async t => {
	let isUnrefCalled = false;
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		const timeout = originalSetTimeout(function_, ms);
		timeout.unref = () => {
			isUnrefCalled = true;
			return timeout;
		};

		return timeout;
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('test');
	}, {retries: 1, minTimeout: 10}));

	assert.ok(!isUnrefCalled);
});
