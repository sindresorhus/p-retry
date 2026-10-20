import process from 'node:process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execa} from 'execa';
import delay from 'delay';
import {
	fixture,
	fixtureError,
	rejectsWith,
	removeTemporaryScript,
	temporaryScript,
	captureDelays,
	collapseDelays,
	withFakeTime,
} from './helpers.js';
import pRetry, {AbortError} from './index.js';

test('handles async shouldRetry with maxRetryTime', async t => {
	const delays = collapseDelays(t);
	const originalPerformanceNow = performance.now;
	let now = 0;

	// Both clocks are controlled. With real ones the callback's wait has to fit inside the budget for a delay to be scheduled at all, which is a real time dependency with nothing behind it. The clock is driven by the test rather than by the wait, so that the callback is what spends the budget and the delays can be read off exactly.
	performance.now = () => now;

	t.after(() => {
		performance.now = originalPerformanceNow;
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
	), {message: 'test'});

	// Each attempt costs 100ms of a 1000ms budget inside the callback, so the tenth attempt finds nothing left. Were the callback time not counted, the clock would never move, so every delay would be the full 1000ms and the run would use all 11 attempts.
	assert.equal(attempts, 10);
	assert.deepEqual(delays, [900, 800, 700, 600, 500, 400, 300, 200, 100]);
});

test('onFailedAttempt can return a promise to add a delay', {timeout: 30_000}, async t => {
	const waitFor = 100;
	const {delays} = await withFakeTime(t);
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

	// The callback's own wait is recorded, and the backoff after it is unchanged. The fake clock records a wait when it is scheduled, so this cannot see whether the callback is awaited. The thenable and callback rejection tests cover that.
	assert.deepEqual(delays, [waitFor, 1000]);
});

test('the backoff is the previous delay times the factor', async t => {
	// A factor of 0 would give 100 then 0 forever, so it is clamped to 1 and behaves like a factor of 1.
	const table = new Map([
		[0, [100, 100, 100]],
		[0.1, [100, 10]],
		[0.5, [100, 50, 25]],
		[1, [100, 100, 100]],
		[2, [100, 200, 400]],
		[3, [100, 300, 900]],
	]);

	// Installed once. The rows share the array, so each one reads from where the last one stopped.
	const delays = collapseDelays(t);
	let readFrom = 0;

	for (const [factor, expected] of table) {
		let attempts = 0;

		await assert.rejects(pRetry(async () => {
			attempts++;
			throw new Error('test');
		}, {
			retries: expected.length,
			factor,
			minTimeout: 100,
			maxTimeout: Infinity,
			randomize: false,
		}), {message: 'test'});

		// `retries` is the number of retries, and the last attempt has nothing left to wait for.
		assert.deepEqual(delays.slice(readFrom), expected, `factor ${factor}`);
		readFrom = delays.length;
		assert.equal(attempts, expected.length + 1, `factor ${factor}`);
	}
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

	// The wall clock jumps a second backwards on the second attempt. A monotonic clock ignores that and gives up once the simulated 120ms is past the 100ms budget, so the run stops at two.
	assert.equal(attempts, 2);
});

test('maxTimeout caps retry delays', async t => {
	const delays = collapseDelays(t);

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
	), {message: 'test'});

	assert.deepEqual(delays, [100, 150, 150]);
});

test('shouldConsumeRetry time counts toward maxRetryTime', {timeout: 30_000}, async t => {
	let attempts = 0;
	const {delays} = await withFakeTime(t);
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
	const delays = collapseDelays(t);

	// A delay this large does not fit in a 32-bit integer, so `setTimeout` would fire it right away.
	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 2 ** 31,
		maxTimeout: Infinity,
	}), {message: 'fail'});

	assert.deepEqual(delays, [(2 ** 31) - 1]);
});

test('delays stay 0 when minTimeout is 0 and the factor overflows', async t => {
	// The factor grows to `Infinity` after enough attempts, and `0 * Infinity` is `NaN`.
	const scheduledDelays = collapseDelays(t);
	const retryDelays = [];

	await assert.rejects(pRetry(async () => {
		throw new Error('test');
	}, {
		retries: 1030,
		minTimeout: 0,
		factor: 2,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}), {message: 'test'});

	assert.equal(retryDelays.length, 1031);

	// The name claims the delays stay at 0, so check that. A zero delay schedules no timer at all.
	assert.ok(retryDelays.every(value => value === 0), 'every delay is 0');
	assert.deepEqual(scheduledDelays, [], 'no timer was scheduled');
});

test('no timer is scheduled when no retry follows', async t => {
	// The delay is long enough that a timer would be unmistakable in `delays`, and collapsed so a regression fails at once instead of waiting it out.
	const delays = collapseDelays(t);

	const table = [
		['shouldRetry refuses the retry', {retries: 3, shouldRetry: () => false}, async () => {
			throw new Error('fail');
		}, {message: 'fail'}],
		['the retry is not consumed', {retries: 5, shouldConsumeRetry: () => false}, (() => {
			let attempts = 0;
			// A skipped retry has no delay of its own, so the second attempt is what ends the run.
			return async () => {
				attempts++;
				if (attempts > 1) {
					throw new AbortError('stop');
				}

				throw new Error('fail');
			};
		})(), {message: 'stop'}],
		['the budget is already spent', {retries: 3, maxRetryTime: 0}, async () => {
			throw new Error('fail');
		}, {message: 'fail'}],
		['the error is never retried', {retries: 3}, async () => {
			throw new TypeError('nope');
		}, {name: 'TypeError', message: 'nope'}],
	];

	for (const [label, options, input, expected] of table) {
		const before = delays.length;

		await assert.rejects(pRetry(input, {minTimeout: 5000, ...options}), expected, label);

		assert.deepEqual(delays.slice(before), [], label);
	}
});

test('the delay that is scheduled is the one the callbacks are shown', async t => {
	const delays = collapseDelays(t);
	const retryDelays = [];
	const originalRandom = Math.random;
	const sequence = [0, 0.999, 0.5];
	let draws = 0;

	Math.random = () => sequence[draws++] ?? 0;

	t.after(() => {
		Math.random = originalRandom;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 100,
		factor: 2,
		randomize: true,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}), {message: 'fail'});

	// The last failure has nothing left to wait for, so its reported delay of 0 has no timer behind it.
	assert.deepEqual(delays, retryDelays.slice(0, -1));
	assert.equal(retryDelays.at(-1), 0);
});

test('unref is applied to a delay shortened by maxRetryTime', {timeout: 30_000}, async t => {
	let unrefCalls = 0;
	const originalSetTimeout = setTimeout;
	const originalPerformanceNow = performance.now;
	let now = 0;

	performance.now = () => now;
	globalThis.setTimeout = function_ => {
		const token = originalSetTimeout(function_, 0);
		token.unref = () => {
			unrefCalls++;
			return token;
		};

		return token;
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
		performance.now = originalPerformanceNow;
	});

	await assert.rejects(pRetry(async () => {
		now += 90; // Leaves 10 of the 100ms budget.
		throw new Error('fail');
	}, {
		retries: 2,
		minTimeout: 1000,
		maxRetryTime: 100,
		unref: true,
	}), {message: 'fail'});

	// The 1000ms delay was trimmed to the 10ms that was left, and the trimmed timer still has to be unref'd.
	assert.equal(unrefCalls, 1);
});

test('randomize affects retry delays', async t => {
	const delays = collapseDelays(t);
	const originalRandom = Math.random;
	let calls = 0;
	const sequence = [0, 1, 0.5]; // → factors 1x, 2x, 1.5x

	Math.random = () => sequence[calls++] ?? 0;

	t.after(() => {
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
	), {message: 'test'});

	assert.deepEqual(delays, [100, 200, 150]);
});

test('a randomized delay is only drawn when a retry is still possible', async t => {
	collapseDelays(t);
	const originalRandom = Math.random;
	let draws = 0;

	Math.random = () => {
		draws++;
		return 0.5;
	};

	t.after(() => {
		Math.random = originalRandom;
	});

	// The delay is computed before `shouldRetry` and `shouldConsumeRetry` answer, since they are shown the delay that would be used. It is not computed once the budget, the error type, or the retry count has already ruled a retry out, so a run that is over does not draw from `Math.random`.
	const table = [
		['one retry', {retries: 1}, 1],
		['no retries', {retries: 0}, 0],
		['a retry that shouldRetry then refuses', {retries: 3, shouldRetry: () => false}, 1],
		['an exhausted budget', {retries: 3, maxRetryTime: 0}, 0],
	];

	for (const [label, options, expected] of table) {
		draws = 0;

		await assert.rejects(pRetry(async () => {
			throw new Error('fail');
		}, {minTimeout: 10, randomize: true, ...options}), {message: 'fail'}, label);

		assert.equal(draws, expected, label);
	}

	// A failure that is never retried does not compute a delay either.
	draws = 0;

	await assert.rejects(pRetry(async () => {
		throw new TypeError('nope');
	}, {minTimeout: 10, randomize: true, retries: 3}), {name: 'TypeError'});

	assert.equal(draws, 0);
});

test('the time the operation takes counts toward maxRetryTime', {timeout: 30_000}, async t => {
	const {delays} = await withFakeTime(t);
	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			await delay(400);
			throw new Error('test');
		},
		{
			retries: 10,
			minTimeout: 100,
			maxRetryTime: 1000,
		},
	), {message: 'test'});

	// Each attempt costs 400 of the 1000ms budget, so the third one runs it out. Were the operation's own time not counted, only the delays would spend the budget, and the run would use 5 attempts. The second delay is the exact sequence as well: the backoff asked for 200ms, but only 100 was left, so it was trimmed.
	assert.equal(attempts, 3);
	assert.deepEqual(delays, [400, 100, 400, 100, 400]);
});

test('onFailedAttempt time counts toward maxRetryTime', {timeout: 30_000}, async t => {
	let attempts = 0;
	let retryDecisions = 0;
	const {delays} = await withFakeTime(t);
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
			shouldRetry() {
				retryDecisions++;
				return true;
			},
		},
	), {message: 'fail'});

	assert.equal(attempts, 1);
	// The budget ran out inside `onFailedAttempt`, so `shouldRetry` is not asked.
	assert.equal(retryDecisions, 0);
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

	// Abort shortly after the first failure schedules its delay. Set up before the mock, so only p-retry's own waits are recorded.
	setTimeout(() => controller.abort(fixtureError), 50);

	const delays = captureDelays(t);

	// The delay is a minute, so a missed abort fails on the test timeout rather than passing late. `unref` keeps a regression from also holding the process open for that minute.
	await assert.rejects(pRetry(async () => {
		throw new Error('retry');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 60_000,
		factor: 2,
		unref: true,
	}), rejectsWith(fixtureError));

	// The abort ended the one delay that was scheduled, so no second retry was scheduled. Whether the timer was also cleared is only visible from outside the process, see the subprocess test below.
	assert.deepEqual(delays, [60_000]);
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
	}), {message: 'test'});

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
	}, {retries: 1, minTimeout: 10, unref: true}), {message: 'fail'});
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
			// Short, but still a real timer, so the retry goes through the event loop.
			minTimeout: 10,
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
		const {stderr, stdout} = await execa(process.execPath, [temporaryFile], {timeout: 20_000, reject: false});
		const output = stderr + stdout;
		const stack = output.split('STACKTRACE_START', 2)[1]?.split('STACKTRACE_END', 1)[0]?.trim();

		assert.ok(stack, 'Should capture stack trace output');

		assert.match(stack, /Error: foo2 failed/v);

		// Matched as frames, so the message line and the file path cannot stand in for a function name.
		const frame = name => new RegExp(String.raw`^\s*at async ${name} `, 'v');

		// Check order
		const lines = stack.split('\n');
		const foo2Index = lines.findIndex(line => frame('foo2').test(line));
		const foo1Index = lines.findIndex(line => frame('foo1').test(line));
		const mainIndex = lines.findIndex(line => frame('main').test(line));

		assert.notStrictEqual(foo2Index, -1, 'foo2 should appear in the stack trace');
		assert.ok(foo1Index > foo2Index, 'foo1 should appear after foo2');
		assert.ok(mainIndex > foo1Index, 'main should appear after foo1');
	} finally {
		await removeTemporaryScript(temporaryFile);
	}
});

test('retryDelay is provided in onFailedAttempt context', async t => {
	collapseDelays(t);
	const retryDelays = [];

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
	), {message: 'test'});

	// Verify retryDelay follows exponential backoff formula, ending with 0 when no retry remains
	assert.deepEqual(retryDelays, [100, 200, 400, 0]);
});

test('Only consumed retries advance backoff', async t => {
	const timeouts = collapseDelays(t);
	let attempts = 0;
	const maxAttempts = 4;
	const minTimeout = 50;
	const factor = 2;
	const contexts = [];

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
	), {message: 'stop'});

	// The skipped failure did not count toward `retries: 2`, so a fourth attempt still ran.
	assert.equal(attempts, maxAttempts);
	assert.deepEqual(contexts.map(context => context.retriesConsumed), [0, 0, 1]);
	assert.deepEqual(contexts.map(context => context.retriesLeft), [2, 2, 1]);
	assert.deepEqual(timeouts, [minTimeout, minTimeout * factor]);
});

test('the delay is truncated to the time left', async t => {
	const delays = collapseDelays(t);
	const originalPerformanceNow = performance.now;
	let now = 0;

	// Both clocks are controlled. With real ones, the first attempt has to complete inside the 100ms budget for any delay to be scheduled at all, which leaves roughly 10ms of headroom before a slow worker turns this into a zero-length run that asserts nothing. The clock is driven by the test, so each attempt costs a fixed amount and the trim can be read off exactly.
	performance.now = () => now;

	t.after(() => {
		performance.now = originalPerformanceNow;
	});

	// Each delay wants more than the whole budget, so each is trimmed to what is left, which shrinks by the cost of the attempt in between.
	await assert.rejects(pRetry(async () => {
		now += 10;
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 1000,
		maxRetryTime: 100,
	}), {message: 'fail'});

	assert.deepEqual(delays, [90, 80, 70]);
});

test('the delays work with the built-in test timer mocking', async t => {
	// The readme points at `mock.timers` as the way to test with this package, so the timers have to come from the global scope at call time.
	t.mock.timers.enable({apis: ['setTimeout']});

	let attempts = 0;
	const promise = pRetry(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return fixture;
	}, {retries: 3, minTimeout: 1000});

	// The delay is only scheduled once the failure has settled, and the retry only starts once the timer has been ticked past.
	for (const wait of [1000, 2000]) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
		t.mock.timers.tick(wait);
	}

	await new Promise(resolve => {
		setImmediate(resolve);
	});

	assert.equal(await promise, fixture);
	assert.equal(attempts, 3);
});

test('a minTimeout below half a millisecond schedules no timer', async t => {
	// Documented, because it is the same no-timer state as `minTimeout: 0`. The second row is the control that shows where the rounding turns over. `randomize` is off, since it scales the delay up first and moves the threshold.
	const delays = collapseDelays(t);
	let readFrom = 0;

	for (const [minTimeout, expected] of [[0.4, []], [0.5, [1]]]) {
		await assert.rejects(pRetry(async () => {
			throw new Error('fail');
		}, {
			retries: 1,
			minTimeout,
			factor: 1,
			randomize: false,
		}), {message: 'fail'}, String(minTimeout));

		assert.deepEqual(delays.slice(readFrom), expected, String(minTimeout));
		readFrom = delays.length;
	}

	// `randomize` scales the delay up before it is rounded, so the same `minTimeout` can get back above the threshold.
	const originalRandom = Math.random;

	Math.random = () => 0.9;

	t.after(() => {
		Math.random = originalRandom;
	});

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 0.4,
		factor: 1,
		randomize: true,
	}), {message: 'fail'});

	assert.deepEqual(delays.slice(readFrom), [1]);
});

test('randomized delays stay within minTimeout and maxTimeout', async t => {
	collapseDelays(t);
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
	}), {message: 'fail'});

	// 100 * ~2 is 200, then the doubling is capped at `maxTimeout`, and the last one has nothing left.
	assert.deepEqual(retryDelays, [200, 300, 300, 300, 300, 0]);
});

test('maxTimeout caps the delay, and rounds a fractional cap up', {timeout: 30_000}, async t => {
	// A fractional `maxTimeout` must not give a fractional delay. It rounds up, so a cap below 1 still schedules a timer and yields to the event loop.
	//
	// `minTimeout` of 100 is above every cap here, so every retry is capped. Each row names its own retry count, because a row with no retries never computes a delay at all and would assert nothing: a cap of 0 is the one row that has to retry to show that it scheduled no timer.
	const table = new Map([
		[10.5, {retries: 3, expected: [11, 11, 11]}],
		[7.5, {retries: 3, expected: [8, 8, 8]}],
		[13, {retries: 3, expected: [13, 13, 13]}],
		[50, {retries: 1, expected: [50]}],
		[0.5, {retries: 2, expected: [1, 1]}],
		[0, {retries: 2, expected: []}],
	]);

	// Installed once. The rows share the array, so each one reads from where the last one stopped.
	const delays = collapseDelays(t);
	let readFrom = 0;

	for (const [maxTimeout, {retries, expected}] of table) {
		let attempts = 0;

		await assert.rejects(pRetry(async () => {
			attempts++;
			throw new Error('fail');
		}, {
			retries,
			minTimeout: 100,
			factor: 1.5,
			maxTimeout,
			randomize: false,
		}), {message: 'fail'}, `maxTimeout ${maxTimeout}`);

		// Every row must really retry, or an empty `expected` would pass without a single delay computed.
		assert.equal(attempts, retries + 1, `maxTimeout ${maxTimeout}`);
		assert.deepEqual(delays.slice(readFrom), expected, `maxTimeout ${maxTimeout}`);
		readFrom = delays.length;
	}
});

test('unref lets the process exit while a retry is pending', {timeout: 15_000}, async () => {
	// A real process, because the point is whether a pending timer keeps it alive. The marker is printed before the await, so a script that dies on its first line is told apart from one that ran, reached `pRetry`, and then let the process go.
	const temporaryFile = await temporaryScript('p-retry-unref-test.mjs', `
console.log('started');
await pRetry(async () => {
	throw new Error('fail');
}, {retries: 5, minTimeout: 60_000, unref: true});
`);

	try {
		// The pending delay is a minute, so this can only finish if `unref` did its job. The subprocess timeout sits below this test's own, so a regression fails on the assertion rather than as a hang.
		const {timedOut, exitCode, stdout} = await execa(process.execPath, [temporaryFile], {timeout: 8000, reject: false});
		assert.match(stdout, /started/v, 'the script reached p-retry');
		assert.ok(!timedOut, 'the process should exit while a retry is pending');
		// Node exits with 13 when the top-level await is still unsettled, so this proves the retry was pending and `pRetry` did not reject early.
		assert.equal(exitCode, 13, 'the retry should still be pending when the process exits');
	} finally {
		await removeTemporaryScript(temporaryFile);
	}
});

test('aborting during a delay does not leave the timer running', {timeout: 15_000}, async () => {
	// A real process, because a timer that was never cleared is only visible as the process refusing to exit. Nothing else in the suite can tell a cleared delay from one that still has 60s to run.
	const temporaryFile = await temporaryScript('p-retry-abort-timer-test.mjs', `
const controller = new AbortController();
setTimeout(() => {
	controller.abort(new Error('cancelled'));
}, 50);

try {
	await pRetry(async () => {
		throw new Error('fail');
	}, {signal: controller.signal, retries: 5, minTimeout: 60_000});
} catch (error) {
	console.log('settled: ' + error.message);
}
`);

	try {
		const {timedOut, exitCode, stdout} = await execa(process.execPath, [temporaryFile], {timeout: 8000, reject: false});
		assert.equal(exitCode, 0, 'the script ran to completion');
		// Printed after the retry settles, so it is only reached if the abort landed and was waited out.
		assert.match(stdout, /settled: cancelled/v, 'the abort settled the pending retry');
		assert.ok(!timedOut, 'the abort should clear the pending delay');
	} finally {
		await removeTemporaryScript(temporaryFile);
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
	}, {retries: 1, minTimeout: 10}), {message: 'test'});

	assert.ok(!isUnrefCalled);
});
