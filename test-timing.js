import fs from 'node:fs/promises';
import {execa} from 'execa';
import test from 'ava';
import delay from 'delay';
import {
	fixture, fixtureError, temporaryScript, captureDelays,
} from './helpers.js';
import pRetry, {AbortError} from './index.js';

test.serial('handles async shouldRetry with maxRetryTime', async t => {
	let attempts = 0;
	const delays = captureDelays(t);
	const maxRetryTime = 1000;

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{
			retries: 10,
			maxRetryTime,
			async shouldRetry() {
				await delay(100);
				return true;
			},
		},
	));

	// Each attempt spends 100ms inside the callback, so the budget runs out well before the 10
	// retries do. Were the callback time not counted, the backoff would schedule past `maxRetryTime`.
	t.true(attempts < 10);
	t.true(delays.length > 0);
	for (const delay of delays) {
		t.true(delay <= maxRetryTime, `${delay} is within the retry budget`);
	}
});

test.serial('onFailedAttempt can return a promise to add a delay', async t => {
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
	t.deepEqual(delays, [waitFor, 1000]);
});

test.serial('factor affects exponential backoff', async t => {
	// Stronger test: capture actual scheduled delays via mocked setTimeout
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0); // Execute immediately to avoid slowing tests
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 2,
			minTimeout: 100,
			maxTimeout: Number.POSITIVE_INFINITY,
			randomize: false,
		},
	));

	t.deepEqual(captured, [100, 200, 400]);
});

test.serial('timeouts are incremental with factor', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 0.5,
			minTimeout: 100,
			maxTimeout: Number.POSITIVE_INFINITY,
			randomize: false,
		},
	));

	// With factor 0.5 and minTimeout 100, expected delays: 100, 50, 25 (before rounding)
	t.deepEqual(captured, [100, 50, 25]);
});

test.serial('setTimeout is never called with 0 minTimeout', async t => {
	let called = false;
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = function_ => {
		called = true;
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 3,
			factor: 0.5,
			minTimeout: 0,
			maxTimeout: Number.POSITIVE_INFINITY,
			randomize: false,
		},
	));

	t.is(called, false);
});

test.serial('maxRetryTime uses monotonic clock', async t => {
	const originalDateNow = Date.now;
	const originalPerformanceNow = performance.now;

	let simulatedDateNow = 0;
	Date.now = () => simulatedDateNow;

	let simulatedMonotonicTimestamp = 0;
	performance.now = () => simulatedMonotonicTimestamp;

	t.teardown(() => {
		Date.now = originalDateNow;
		performance.now = originalPerformanceNow;
	});

	let attempts = 0;

	await t.throwsAsync(pRetry(
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
	t.is(attempts, 2);
});

test.serial('minTimeout is respected even with small factor', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 2,
			factor: 0.1,
			minTimeout: 100,
			maxTimeout: Number.POSITIVE_INFINITY,
			randomize: false,
		},
	));

	// First delay is at least minTimeout. Second is minTimeout * 0.1 = 10
	t.deepEqual(captured, [100, 10]);
});

test.serial('maxTimeout caps retry delays', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
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

	t.deepEqual(captured, [100, 150, 150]);
});

test.serial('skipped attempts do not impact backoff', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0, ...arguments_);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	let attempts = 0;

	await t.throwsAsync(pRetry(
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
			maxTimeout: Number.POSITIVE_INFINITY,
			randomize: false,
			shouldConsumeRetry: ({error}) => error.message !== 'skip',
		},
	));

	// Skip should not shift the backoff sequence; it simply retries without consuming budget.
	t.deepEqual(captured, [100, 200, 400]);
	// One skipped attempt plus three counted retries, plus the final failure.
	t.is(attempts, 5);
});

test.serial('shouldConsumeRetry time counts toward maxRetryTime', async t => {
	let attempts = 0;
	const delays = captureDelays(t);
	const maxRetryTime = 200;

	const error = await t.throwsAsync(pRetry(
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
	));

	t.is(error.message, 'fail');
	t.is(attempts, 1);
	// The only wait is the callback's own 300ms, so p-retry scheduled no retry delay at all.
	t.deepEqual(delays, [300]);
});

test.serial('delays are clamped to the setTimeout maximum', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	// A delay this large does not fit in a 32-bit integer, so `setTimeout` would fire it right away.
	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 2 ** 31,
		maxTimeout: Number.POSITIVE_INFINITY,
	}));

	t.deepEqual(captured, [(2 ** 31) - 1]);
});

test.serial('delays stay 0 when minTimeout is 0 and the factor overflows', async t => {
	// The factor grows to `Infinity` after enough attempts, and `0 * Infinity` is `NaN`.
	const retryDelays = [];
	const scheduledDelays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		scheduledDelays.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 1030,
		minTimeout: 0,
		factor: 2,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}));

	t.is(retryDelays.length, 1031);
	t.false(retryDelays.some(delay => Number.isNaN(delay)));
	t.false(scheduledDelays.some(delay => Number.isNaN(delay)));
});

test.serial('maxTimeout lower than minTimeout caps delay', async t => {
	// Assert the scheduled delay instead of wall clock time, which is unreliable under load.
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 200,
		maxTimeout: 50,
		factor: 1,
	}));

	// Capped by `maxTimeout`, so the single delay is 50ms and not `minTimeout` (200ms).
	t.deepEqual(captured, [50]);
});

test.serial('randomize affects retry delays', async t => {
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

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
		Math.random = originalRandom;
	});

	await t.throwsAsync(pRetry(
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

	t.deepEqual(captured, [100, 200, 150]);
});

test.serial('maxRetryTime limits total retry duration', async t => {
	const delays = captureDelays(t);
	const maxRetryTime = 1000;

	await t.throwsAsync(pRetry(
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
	for (const delay of delays) {
		t.true(delay > 0 && delay <= maxRetryTime, `${delay} is within the retry budget`);
	}
});

test.serial('onFailedAttempt time counts toward maxRetryTime', async t => {
	let attempts = 0;
	const delays = captureDelays(t);
	const maxRetryTime = 200;

	const error = await t.throwsAsync(pRetry(
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
	));

	t.is(error.message, 'fail');
	t.is(attempts, 1);
	// The only wait is the callback's own 300ms, so p-retry scheduled no retry delay at all.
	t.deepEqual(delays, [300]);
});

test.serial('signal already aborted when entering delay phase cancels immediately', async t => {
	const controller = new AbortController();
	const delays = captureDelays(t);

	// Signal aborts before entering the delay phase (e.g., during input function execution)
	await t.throwsAsync(pRetry(async () => {
		controller.abort(fixtureError);
		throw new Error('input failed');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 5000, // Long delay to verify we don't wait
	}), {is: fixtureError});

	// The 5 second delay was never scheduled, so there was nothing to wait out.
	t.deepEqual(delays, []);
});

test.serial('signal abort during delay cancels promptly', async t => {
	const controller = new AbortController();

	// Abort shortly after the first failure schedules its delay. Set up before the mock, so only
	// p-retry's own waits are recorded.
	setTimeout(() => controller.abort(fixtureError), 50);

	const delays = captureDelays(t);

	await t.throwsAsync(pRetry(async () => {
		throw new Error('retry');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 500,
		factor: 2,
	}), {is: fixtureError});

	// The 500ms delay was cleared when the abort landed, so the second retry never happened.
	t.deepEqual(delays, [500]);
});

test.serial('factor <= 0 is treated as 1 (stable delays)', async t => {
	const delays = captureDelays(t);
	let calls = 0;

	await t.throwsAsync(pRetry(async () => {
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
	t.deepEqual(delays, [100, 100, 100]);
	t.is(calls, 4);
});

test.serial('unref option prevents timeout from keeping process alive', async t => {
	let timeoutUnrefCalled = false;

	// Mock setTimeout to track unref calls
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		const timeout = originalSetTimeout(function_, ms);
		timeout.unref = () => {
			timeoutUnrefCalled = true;
			return timeout;
		};

		return timeout;
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 2,
		minTimeout: 50,
		unref: true,
	}));

	t.true(timeoutUnrefCalled, 'timeout.unref() should be called when unref option is true');
});

test.serial('unref option handles missing unref gracefully', async t => {
	const originalSetTimeout = setTimeout;
	globalThis.setTimeout = (function_, ms) => {
		const id = originalSetTimeout(function_, ms);
		return Number(id); // No `unref` property
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {retries: 1, minTimeout: 10, unref: true}));
});

test('preserves user stack trace through async retries', async t => {
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
		const stack = output.split('STACKTRACE_START')[1]?.split('STACKTRACE_END')[0]?.trim();

		t.truthy(stack, 'Should capture stack trace output');

		t.regex(stack, /Error: foo2 failed/);

		// Print the stack for debugging if needed
		if (!/foo2/.test(stack) || !/foo1/.test(stack) || !/main/.test(stack)) {
			console.log('\n==== Full stack trace for debugging ====\n' + stack + '\n==== End stack trace ====\n');
		}

		t.regex(stack, /foo2/);
		t.regex(stack, /foo1/);
		t.regex(stack, /main/);

		// Check order
		const lines = stack.split('\n');
		const foo2Index = lines.findIndex(line => /foo2/.test(line));
		const foo1Index = lines.findIndex(line => /foo1/.test(line));
		const mainIndex = lines.findIndex(line => /main/.test(line));

		t.true(foo2Index !== -1, 'foo2 should appear in the stack trace');
		t.true(foo1Index > foo2Index, 'foo1 should appear after foo2');
		t.true(mainIndex > foo1Index, 'main should appear after foo1');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test.serial('retryDelay is provided in onFailedAttempt context', async t => {
	const retryDelays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, _ms) => originalSetTimeout(function_, 0);

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
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
	t.deepEqual(retryDelays, [100, 200, 400, 0]);
});

test.serial('Only consumed retries advance backoff', async t => {
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

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(
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

	t.deepEqual(contexts.map(context => context.retriesConsumed), [0, 0, 1]);
	t.deepEqual(contexts.map(context => context.retriesLeft), [2, 2, 1]);
	t.deepEqual(timeouts, [minTimeout, minTimeout * factor]);
});

test.serial('the delay is truncated to the time left', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	// The first delay wants a full second, but only 100ms of the budget is left.
	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 1000,
		maxRetryTime: 100,
	}));

	t.true(captured.length > 0);
	for (const delay of captured) {
		t.true(delay > 0 && delay <= 100, `${delay} is within the remaining time`);
	}
});

test.serial('randomized delays stay within minTimeout and maxTimeout', async t => {
	const originalRandom = Math.random;
	const retryDelays = [];

	// The multiplier is 1 + `Math.random()`, so this is just under 2.
	Math.random = () => 0.999;

	t.teardown(() => {
		Math.random = originalRandom;
	});

	await t.throwsAsync(pRetry(async () => {
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
	t.deepEqual(retryDelays, [200, 300, 300, 300, 300, 0]);
});

test.serial('factor: 1 keeps the delay constant', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 3,
		factor: 1,
		minTimeout: 100,
		randomize: false,
	}));

	t.deepEqual(captured, [100, 100, 100]);
});

test.serial('maxTimeout: 0 retries without waiting', async t => {
	const captured = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		captured.push(ms);
		return originalSetTimeout(function_, 0);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 2,
		minTimeout: 100,
		maxTimeout: 0,
	}));

	t.deepEqual(captured, []);
});

test.serial('unref lets the process exit while a retry is pending', async t => {
	// A real process, because the point is whether a pending timer keeps it alive.
	const temporaryFile = await temporaryScript('p-retry-unref-test.mjs', `
try {
	await pRetry(async () => {
		throw new Error('fail');
	}, {retries: 5, minTimeout: 60_000, unref: true});
} catch {}
`);

	try {
		// The pending delay is a minute, so this can only finish if \`unref\` did its job. The timeout
		// sits below AVA's own, so a regression fails on the assertion rather than as a hang.
		const {timedOut} = await execa('node', [temporaryFile], {timeout: 8000, reject: false});
		t.false(timedOut, 'the process should exit while a retry is pending');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test.serial('aborting during a delay does not leave the timer running', async t => {
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
		t.false(timedOut, 'the abort should clear the pending delay');
	} finally {
		await fs.unlink(temporaryFile);
	}
});

test.serial('unref is not applied unless the option is set', async t => {
	let unrefCalled = false;
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms) => {
		const timeout = originalSetTimeout(function_, ms);
		timeout.unref = () => {
			unrefCalled = true;
			return timeout;
		};

		return timeout;
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await t.throwsAsync(pRetry(async () => {
		throw new Error('test');
	}, {retries: 1, minTimeout: 10}));

	t.false(unrefCalled);
});
