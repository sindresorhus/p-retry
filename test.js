import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execa} from 'execa';
import test from 'ava';
import delay from 'delay';
import pRetry, {makeRetriable, AbortError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('retries', async t => {
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
	});

	t.is(returnValue, fixture);
	t.is(index, 3);
});

test('retries forever when specified', async t => {
	let attempts = 0;
	const maxAttempts = 15; // Limit for test purposes

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;
			if (attempts === maxAttempts) {
				throw new AbortError('stop');
			}

			throw new Error('test');
		},
		{
			retries: Number.POSITIVE_INFINITY,
			minTimeout: 0, // Speed up test
		},
	));

	t.is(attempts, maxAttempts);
});

// Error Handling Tests
test('throws useful error message when non-error is thrown', async t => {
	await t.throwsAsync(pRetry(() => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}), {
		message: /Non-error/,
	});
});

test('no retry on TypeError', async t => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let index = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	}), {is: typeErrorFixture});

	t.is(index, 1);
});

test('shouldRetry is not called for non-network TypeError', async t => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let shouldRetryCalled = 0;

	await t.throwsAsync(pRetry(async () => {
		throw typeErrorFixture;
	}, {
		shouldRetry() {
			shouldRetryCalled++;
			return true;
		},
	}), {is: typeErrorFixture});

	t.is(shouldRetryCalled, 0);
});

test('retry on TypeError - failed to fetch', async t => {
	const typeErrorFixture = new TypeError('Failed to fetch');
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	});

	t.is(returnValue, fixture);
	t.is(index, 3);
});

test('errors are preserved when maxRetryTime exceeded', async t => {
	const originalError = new Error('original error');
	const maxRetryTime = 100;
	let startTime;

	const error = await t.throwsAsync(pRetry(
		async () => {
			startTime ||= Date.now();

			await delay(maxRetryTime + 50); // Ensure we exceed maxRetryTime
			throw originalError;
		},
		{
			maxRetryTime,
			minTimeout: 0,
		},
	));

	t.is(error, originalError);
});

test('AbortError - string', t => {
	const error = new AbortError('fixture').originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('AbortError - error', t => {
	const error = new AbortError(new Error('fixture')).originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('aborts', async t => {
	let index = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? Promise.reject(new AbortError(fixtureError)) : Promise.reject(fixtureError);
	}), {is: fixtureError});

	t.is(index, 3);
});

test('operation stops immediately on AbortError', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;
			if (attempts === 2) {
				throw new AbortError('stop');
			}

			throw new Error('test');
		},
		{
			retries: 10,
			minTimeout: 0,
		},
	));

	t.is(attempts, 2); // Should stop after AbortError
});

test('shouldRetry is not called for AbortError', async t => {
	let shouldRetryCalled = 0;

	await t.throwsAsync(pRetry(async () => {
		throw new AbortError('stop');
	}, {
		shouldRetry() {
			shouldRetryCalled++;
			return true;
		},
	}), {message: 'stop'});

	t.is(shouldRetryCalled, 0);
});

// AVA does not support DOMException.
// test('aborts with an AbortSignal', async t => {
// 	let index = 0;
// 	const controller = new AbortController();

// 	await t.throwsAsync(pRetry(async ({attemptNumber}) => {
// 		await delay(40);
// 		index++;
// 		if (attemptNumber === 3) {
// 			controller.abort();
// 		}

// 		throw fixtureError;
// 	}, {
// 		signal: controller.signal,
// 	}), {
// 		instanceOf: DOMException,
// 	});

// 	t.is(index, 3);
// });

test('preserves the abort reason', async t => {
	let index = 0;
	const controller = new AbortController();

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		if (attemptNumber === 3) {
			controller.abort(fixtureError);
			return;
		}

		throw fixtureError;
	}, {
		signal: controller.signal,
	}), {
		is: fixtureError,
	});

	t.is(index, 3);
});

test('shouldRetry controls retry behavior', async t => {
	const shouldRetryError = new Error('should-retry');
	const customError = new Error('custom-error');
	let index = 0;

	await t.throwsAsync(pRetry(async () => {
		await delay(40);
		index++;
		const error = index < 3 ? shouldRetryError : customError;
		throw error;
	}, {
		async shouldRetry({error}) {
			return error.message === shouldRetryError.message;
		},
		retries: 10,
	}), {
		is: customError,
	});

	t.is(index, 3);
});

test('onFailedAttempt then shouldRetry order', async t => {
	const order = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('order');
	}, {
		onFailedAttempt() {
			order.push('onFailedAttempt');
		},
		shouldRetry() {
			order.push('shouldRetry');
			return false;
		},
	}));

	t.deepEqual(order, ['onFailedAttempt', 'shouldRetry']);
});

test('handles async shouldRetry with maxRetryTime', async t => {
	let attempts = 0;
	const start = Date.now();
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

	t.true(Date.now() - start <= maxRetryTime + 200);
	t.true(attempts < 10);
});

test('onFailedAttempt provides correct error details', async t => {
	const retries = 5;
	let index = 0;
	let attemptNumber = 0;

	await pRetry(
		async attemptNumber => {
			await delay(40);
			index++;
			return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
		},
		{
			onFailedAttempt({error, attemptNumber: attempt, retriesLeft}) {
				t.is(error, fixtureError);
				t.is(attempt, ++attemptNumber);
				t.is(retriesLeft, retries - (index - 1));
			},
			retries,
		},
	);

	t.is(index, 3);
	t.is(attemptNumber, 2);
});

test('onFailedAttempt is called even when shouldRetry returns false', async t => {
	const error = new Error('fail');
	let onFailedAttemptCount = 0;
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw error;
	}, {
		onFailedAttempt() {
			onFailedAttemptCount++;
		},
		shouldRetry: () => false,
		retries: 5,
	}), {is: error});

	t.is(attempts, 1);
	t.is(onFailedAttemptCount, 1);
});

test('onFailedAttempt can return a promise to add a delay', async t => {
	const waitFor = 1000;
	const start = Date.now();
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

	t.true(Date.now() > start + waitFor);
});

test('onFailedAttempt can throw to abort retries', async t => {
	const error = new Error('thrown from onFailedAttempt');

	await t.throwsAsync(pRetry(async () => {
		throw fixtureError;
	}, {
		onFailedAttempt() {
			throw error;
		},
	}), {
		is: error,
	});
});

test('retry context object is immutable', async t => {
	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		onFailedAttempt(context) {
			// Attempt to mutate frozen object in strict mode should throw
			Object.defineProperty(context, 'foo', {value: 'bar'});
		},
	}));
});

test('onFailedAttempt can be undefined', async t => {
	const error = new Error('thrown from onFailedAttempt');

	await t.throwsAsync(pRetry(() => {
		throw error;
	}, {
		onFailedAttempt: undefined,
		retries: 1,
	}), {
		is: error,
	});
});

test('shouldRetry can be undefined', async t => {
	const error = new Error('thrown from onFailedAttempt');

	await t.throwsAsync(pRetry(() => {
		throw error;
	}, {
		shouldRetry: undefined,
		retries: 1,
	}), {
		is: error,
	});
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

test('maxTimeout lower than minTimeout caps delay', async t => {
	const start = Date.now();
	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 200,
		maxTimeout: 50,
		factor: 1,
	}));
	const elapsed = Date.now() - start;
	// Should be significantly less than minTimeout due to capping
	t.true(elapsed < 200);
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

test('maxRetryTime limits total retry duration', async t => {
	const start = Date.now();
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

	t.true(Date.now() - start < maxRetryTime + 1000);
});

test('onFailedAttempt time counts toward maxRetryTime', async t => {
	let attempts = 0;
	const start = Date.now();
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
	t.true(Date.now() - start < 1000);
});

test('signal abort during delay cancels promptly', async t => {
	const controller = new AbortController();
	const start = Date.now();

	// Abort shortly after the first failure schedules its delay
	setTimeout(() => controller.abort(fixtureError), 50);

	await t.throwsAsync(pRetry(async () => {
		throw new Error('retry');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 500,
		factor: 2,
	}), {is: fixtureError});

	t.true(Date.now() - start < 1000);
});

// AVA does not support DOMException.
// test('aborts immediately if signal is already aborted', async t => {
// 	const controller = new AbortController();
// 	controller.abort();

// 	await t.throwsAsync(pRetry(
// 		async () => {
// 			throw new Error('test');
// 		},
// 		{signal: controller.signal},
// 	), {
// 		instanceOf: DOMException,
// 	});
// });

test('aborts immediately if signal is already aborted with reason', async t => {
	let called = 0;
	const controller = new AbortController();
	controller.abort(fixtureError);

	await t.throwsAsync(pRetry(async () => {
		called++;
		throw new Error('should not run');
	}, {
		signal: controller.signal,
	}), {is: fixtureError});

	t.is(called, 0);
});

test('throws on negative retry count', async t => {
	await t.throwsAsync(
		pRetry(
			async () => {},
			{retries: -1},
		),
		{
			instanceOf: TypeError,
			message: 'Expected `retries` to be a non-negative number.',
		},
	);
});

test('throws on non-number retries', async t => {
	await t.throwsAsync(
		pRetry(
			async () => {},
			// @ts-expect-error - Intentionally wrong type for runtime validation
			{retries: '3'},
		),
		{
			instanceOf: TypeError,
			message: 'Expected `retries` to be a number or Infinity.',
		},
	);
});

test('throws on NaN retries', async t => {
	await t.throwsAsync(
		pRetry(
			async () => {},
			{retries: Number.NaN},
		),
		{
			instanceOf: TypeError,
			message: 'Expected `retries` to be a valid number or Infinity, got NaN.',
		},
	);
});

test('handles zero retries', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{retries: 0},
	));

	t.is(attempts, 1); // Should only try once with zero retries
});

test('onFailedAttempt still called when retries is zero', async t => {
	let onFailedAttemptCount = 0;

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 0,
		onFailedAttempt() {
			onFailedAttemptCount++;
		},
	}));

	t.is(onFailedAttemptCount, 1);
});

test('invalid numeric options throw', async t => {
	await t.throwsAsync(pRetry(async () => {}, {factor: -1}));
	await t.throwsAsync(pRetry(async () => {}, {minTimeout: -1}));
	await t.throwsAsync(pRetry(async () => {}, {maxTimeout: -1}));
	await t.throwsAsync(pRetry(async () => {}, {maxRetryTime: -1}));
});

test.serial('factor <= 0 is treated as 1 (stable delays)', async t => {
	const start = Date.now();
	let calls = 0;

	await t.throwsAsync(pRetry(async () => {
		calls++;
		throw new Error('retry');
	}, {
		retries: 1,
		minTimeout: 100,
		factor: 0,
		// Make delays deterministic
		randomize: false,
	}));

	const elapsed = Date.now() - start;
	// Expect ~1 delay of at least minTimeout
	t.true(elapsed >= 90);
	t.is(calls, 2);
});

test('unsupported `forever` option throws', async t => {
	await t.throwsAsync(pRetry(async () => {}, {forever: true}), {
		message: /no longer supported/,
	});
});

test('handles zero maxRetryTime', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{maxRetryTime: 0},
	));

	t.is(attempts, 1); // Should only try once with zero maxRetryTime
});

test('handles invalid factor values', async t => {
	const delays = [];
	const minTimeout = 100;

	await t.throwsAsync(pRetry(
		async () => {
			const expectedDelay = minTimeout; // Should default to minTimeout
			delays.push(expectedDelay);
			throw new Error('test');
		},
		{
			retries: 2,
			factor: 0, // Invalid factor
			minTimeout,
			randomize: false,
		},
	));

	t.is(delays[0], minTimeout);
	t.is(delays[1], minTimeout);
});

test('handles synchronous input function', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(
		() => { // Non-async function
			attempts++;
			throw new Error('test');
		},
		{retries: 2, minTimeout: 0},
	));

	t.is(attempts, 3); // Initial + 2 retries
});

test('aborts retries if input function returns null', async t => {
	let attempts = 0;

	const result = await pRetry(
		() => {
			attempts++;
			return null;
		},
		{retries: 2},
	);

	t.is(attempts, 1); // Should stop after first success
	t.is(result, null);
});

test('handles non-Error rejection values', async t => {
	await t.throwsAsync(pRetry(
		() => Promise.reject('string rejection'), // eslint-disable-line prefer-promise-reject-errors
		{retries: 1, minTimeout: 0},
	), {
		message: /Non-error was thrown/,
	});
});

test.serial('unref option prevents timeout from keeping process alive', async t => {
	const delays = [];
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

	await t.throwsAsync(pRetry(
		async () => {
			delays.push(Date.now());
			throw new Error('test');
		},
		{
			retries: 2,
			minTimeout: 50,
			unref: true,
		},
	));

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
	const script = `
import pRetry from './index.js';

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
`.trim();

	const temporaryFile = path.join(process.cwd(), 'p-retry-stack-test.js');
	await fs.writeFile(temporaryFile, script);

	try {
		const {stderr, stdout} = await execa('node', [temporaryFile], {reject: false});
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

test('makeRetriable wraps and retries the function', async t => {
	let callCount = 0;
	const function_ = async (a, b) => {
		callCount++;
		if (callCount < 3) {
			throw new Error('fail');
		}

		return a + b;
	};

	const retried = makeRetriable(function_, {retries: 5, minTimeout: 0});
	const result = await retried(2, 3);
	t.is(result, 5);
	t.is(callCount, 3);
});

test('makeRetriable passes arguments and options', async t => {
	let lastArguments;
	const function_ = (...arguments_) => {
		lastArguments = arguments_;
		throw new Error('fail');
	};

	const retried = makeRetriable(function_, {retries: 1, minTimeout: 0});
	await t.throwsAsync(() => retried('foo', 42));
	t.deepEqual(lastArguments, ['foo', 42]);
});

test('makeRetriable preserves `this` context', async t => {
	const object = {
		value: 2,
		calls: 0,
		async add(n) {
			this.calls++;
			if (this.calls < 2) {
				throw new Error('fail');
			}

			return this.value + n;
		},
	};

	object.add = makeRetriable(object.add, {retries: 5, minTimeout: 0});
	const result = await object.add(3);
	t.is(result, 5);
	t.is(object.calls, 2);
});

test('throws error from shouldRetry', async t => {
	const thrown = new Error('shouldRetry failure');

	await t.throwsAsync(pRetry(async () => {
		throw new Error('operation failed');
	}, {
		shouldRetry() {
			throw thrown;
		},
	}), {is: thrown});
});

test('retriesLeft is Infinity when retries is Infinity', async t => {
	let observed;

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: Number.POSITIVE_INFINITY,
		onFailedAttempt({retriesLeft}) {
			observed = retriesLeft;
			throw new Error('stop');
		},
		minTimeout: 0,
	}));

	t.is(observed, Number.POSITIVE_INFINITY);
});

test('wont count SkipError as attempt', async t => {
	let attempts = 0;
	const maxAttempts = 3;

	await t.throwsAsync(pRetry(
		async () => {
			attempts++;

			if (attempts === maxAttempts) {
				throw new AbortError('stop');
			}

			throw new Error('skip');
		},
		{
			retries: 1,
			shouldSkip: error => error.message === 'skip',
			minTimeout: 0, // Speed up test
		},
	));

	t.is(attempts, maxAttempts);
});
