import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execa} from 'execa';
import test from 'ava';
import delay from 'delay';
import pRetry, {makeRetriable, AbortError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

// Scratch scripts for the subprocess tests. Written outside the repository, because a test that gets
// killed mid-run never reaches its cleanup, and a leftover file in the working tree gets committed.
const temporaryScript = async (name, body) => {
	// The worker id keeps two concurrent `ava` runs from clobbering each other's script, and has to
	// go before the extension or Node stops reading the file as a module.
	const file = path.join(os.tmpdir(), `${path.parse(name).name}.${process.pid}${path.extname(name)}`);
	await fs.writeFile(file, `import pRetry from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'index.js')).href)};\n${body}`);
	return file;
};

// Records the delays that were scheduled, so a test can assert on what was waited for instead of on
// how long the machine took. The real delay is kept, so the operation still runs for real.
const captureDelays = t => {
	const delays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		delays.push(ms);
		return originalSetTimeout(function_, ms, ...arguments_);
	};

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	return delays;
};

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

test('values that cannot be stringified still get a useful error message', async t => {
	// Interpolating these into the message throws, which would hide the real failure.
	const values = new Map([
		[Symbol('fixture'), 'Symbol(fixture)'],
		[Object.create(null), '[object Object]'],
		[{toString: null}, '[object Object]'],
	]);

	for (const [value, expected] of values) {
		await t.throwsAsync(pRetry(() => {
			throw value;
		}, {retries: 0}), {
			instanceOf: TypeError,
			message: `Non-error was thrown: "${expected}". You should only throw errors.`,
		});
	}
});

test('a throwing toString does not replace the reported failure', async t => {
	const error = await t.throwsAsync(pRetry(() => {
		throw { // eslint-disable-line no-throw-literal
			toString() {
				throw new Error('toString exploded');
			},
		};
	}, {retries: 0}), {instanceOf: TypeError});

	t.regex(error.message, /^Non-error was thrown/);
});

test('a value that cannot be converted at all still gets a useful error message', async t => {
	// A proxy can throw from the `Symbol.toStringTag` read that the fallback does, too.
	const error = await t.throwsAsync(pRetry(() => {
		throw new Proxy({}, {
			get(target, property) {
				if (property === Symbol.toStringTag) {
					throw new Error('toStringTag exploded');
				}

				return Reflect.get(target, property);
			},
		});
	}, {retries: 0}), {instanceOf: TypeError});

	t.is(error.message, 'Non-error was thrown: "object". You should only throw errors.');
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

test('a shouldConsumeRetry that returns nothing still consumes a retry', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 2,
		minTimeout: 0,
		// A logging-only callback with the `return` forgotten, so it resolves to `undefined`.
		async shouldConsumeRetry({retriesLeft}) {
			attempts += retriesLeft - 1;
		},
	}), {message: 'fail'});

	// `retries` stays the hard bound instead of being ignored forever.
	t.is(attempts, 3);
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

test('async shouldRetry respects maxRetryTime after callback', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 5,
		maxRetryTime: 50,
		minTimeout: 0,
		async shouldRetry() {
			await delay(100);
			return true;
		},
	}));

	t.is(attempts, 1);
});

test('a non-network TypeError is not retried whatever shouldConsumeRetry says', async t => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw typeErrorFixture;
	}, {
		shouldConsumeRetry() {
			return false;
		},
		retries: 5,
		minTimeout: 0,
	}), {is: typeErrorFixture});

	t.is(attempts, 1);
});

test('throws on non-boolean randomize and unref', async t => {
	// `randomize: 'false'` from an env var or a CLI flag is truthy, so it would turn jitter on.
	await t.throwsAsync(pRetry(async () => {}, {randomize: 'yes'}), {
		instanceOf: TypeError,
		message: 'Expected `randomize` to be a boolean.',
	});

	await t.throwsAsync(pRetry(async () => {}, {unref: 'yes'}), {
		instanceOf: TypeError,
		message: 'Expected `unref` to be a boolean.',
	});
});

test('throws on invalid callback options', async t => {
	await t.throwsAsync(pRetry(async () => {}, {
		onFailedAttempt: 1,
	}), {
		message: 'Expected `onFailedAttempt` to be a function.',
	});

	await t.throwsAsync(pRetry(async () => {}, {
		shouldRetry: 1,
	}), {
		message: 'Expected `shouldRetry` to be a function.',
	});

	await t.throwsAsync(pRetry(async () => {}, {
		shouldConsumeRetry: 1,
	}), {
		message: 'Expected `shouldConsumeRetry` to be a function.',
	});
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

	const error = await t.throwsAsync(pRetry(
		async () => {
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

test('AbortError - stack trace keeps the message', t => {
	// The thrown error is `originalError`, so its stack must still name the failure and point at the caller.
	const {stack} = new AbortError('fixture').originalError;
	t.true(stack.startsWith('Error: fixture'));
	t.true(stack.includes('new AbortError'));
	t.true(stack.includes('test.js'));
});

test('AbortError - message is always a string', t => {
	// `Error` stringifies a non-string message, so `AbortError` must too.
	t.is(new AbortError(42).message, '42');
	t.is(new AbortError().message, '');
	t.is(new AbortError().message, new AbortError().originalError.message);
});

test('AbortSignal short-circuits callbacks', async t => {
	const controller = new AbortController();
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		controller.abort(fixtureError);
		return fixture;
	}, {
		signal: controller.signal,
		onFailedAttempt() {
			t.fail('onFailedAttempt should not fire');
		},
		shouldRetry() {
			t.fail('shouldRetry should not fire');
		},
		shouldConsumeRetry() {
			t.fail('shouldConsumeRetry should not fire');
		},
	}), {is: fixtureError});

	t.is(attempts, 1);
});

test('shouldConsumeRetry runs before onFailedAttempt when maxRetryTime is exhausted', async t => {
	const order = [];
	const retryDelays = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		maxRetryTime: 0,
		shouldConsumeRetry() {
			order.push('shouldConsumeRetry');
			return true;
		},
		onFailedAttempt({retryDelay}) {
			order.push('onFailedAttempt');
			retryDelays.push(retryDelay);
		},
		shouldRetry() {
			order.push('shouldRetry');
			return true;
		},
	}), {message: 'fail'});

	// No retry can follow, but the failure is still reported in the documented order.
	t.deepEqual(order, ['shouldConsumeRetry', 'onFailedAttempt']);
	t.deepEqual(retryDelays, [0]);
});

test('retries: null uses the default', async t => {
	// Every option treats `null` as "not provided", so `retries` has to as well.
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: null,
		minTimeout: 0,
	}), {message: 'fail'});

	t.is(attempts, 11); // The default of 10 retries, plus the first attempt.
});

test('null option values use the defaults', async t => {
	// `unref` in particular has to be defaulted before it is validated, or `null` is not a boolean.
	for (const options of [
		{retries: null},
		{factor: null},
		{minTimeout: null},
		{maxTimeout: null},
		{maxRetryTime: null},
		{randomize: null},
		{unref: null},
		{signal: null},
		{onFailedAttempt: null},
		{shouldRetry: null},
		{shouldConsumeRetry: null},
	]) {
		await t.notThrowsAsync(pRetry(async () => fixture, options));
	}
});

test('aborting inside shouldConsumeRetry skips the later callbacks', async t => {
	const controller = new AbortController();
	const calls = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		minTimeout: 0,
		shouldConsumeRetry() {
			calls.push('shouldConsumeRetry');
			controller.abort(fixtureError);
			return true;
		},
		onFailedAttempt() {
			calls.push('onFailedAttempt');
		},
		shouldRetry() {
			calls.push('shouldRetry');
			return true;
		},
	}), {is: fixtureError});

	t.deepEqual(calls, ['shouldConsumeRetry']);
});

test('aborting inside onFailedAttempt skips shouldRetry', async t => {
	const controller = new AbortController();
	const calls = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		minTimeout: 0,
		onFailedAttempt() {
			calls.push('onFailedAttempt');
			controller.abort(fixtureError);
		},
		shouldRetry() {
			calls.push('shouldRetry');
			return true;
		},
	}), {is: fixtureError});

	t.deepEqual(calls, ['onFailedAttempt']);
});

test('a nested AbortError is unwrapped all the way down', async t => {
	// Left wrapped, the real cause would be buried and `error.name` would claim a cancellation.
	await t.throwsAsync(pRetry(async () => {
		throw new AbortError(new AbortError(fixtureError));
	}, {retries: 5, minTimeout: 0}), {is: fixtureError});
});

test('throws on an invalid signal', async t => {
	// Otherwise the failure surfaces as "options.signal?.throwIfAborted is not a function".
	for (const signal of [true, 'abort', {}, {throwIfAborted() {}, addEventListener() {}}]) {
		await t.throwsAsync(pRetry(async () => {}, {signal}), {
			instanceOf: TypeError,
			message: 'Expected `signal` to be an AbortSignal.',
		});
	}
});

test('an AbortError with an unusable originalError still rejects with an error', async t => {
	// `originalError` is writable, so it can be left pointing at nothing.
	const abortError = new AbortError('stop');
	abortError.originalError = undefined;

	const error = await t.throwsAsync(pRetry(async () => {
		throw abortError;
	}, {retries: 5, minTimeout: 0}), {instanceOf: Error});

	t.is(error, abortError);
});

test('aborting while the operation is in flight stops it without waiting out the delay', async t => {
	const controller = new AbortController();
	const calls = [];

	setTimeout(() => {
		controller.abort(fixtureError);
	}, 20);

	await t.throwsAsync(pRetry(async () => {
		// Settles only when the signal aborts, the way a request bound to the signal would.
		const {promise, reject} = Promise.withResolvers();
		controller.signal.addEventListener('abort', () => {
			reject(controller.signal.reason);
		}, {once: true});
		await promise;
	}, {
		signal: controller.signal,
		minTimeout: 60_000, // A minute of waiting if the abort is missed, so the test would hang.
		onFailedAttempt() {
			calls.push('onFailedAttempt');
		},
		shouldRetry() {
			calls.push('shouldRetry');
			return true;
		},
	}), {is: fixtureError});

	t.deepEqual(calls, []);
});

test('a cycle in originalError does not hang', async t => {
	const outer = new AbortError('outer');
	const inner = new AbortError('inner');
	outer.originalError = inner;
	inner.originalError = outer;

	// A synchronous spin here would block the event loop, so the test would time out. Unwrapping
	// walks one link and then meets the cycle, so either wrapper is an acceptable result.
	const error = await t.throwsAsync(pRetry(async () => {
		throw outer;
	}, {retries: 5, minTimeout: 0}), {instanceOf: Error});

	t.true(error === outer || error === inner);
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

test('AbortError short-circuits callbacks', async t => {
	const originalError = new Error('stop');
	let attempts = 0;

	const error = await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new AbortError(originalError);
	}, {
		onFailedAttempt() {
			t.fail('onFailedAttempt should not fire');
		},
		shouldRetry() {
			t.fail('shouldRetry should not fire');
		},
		shouldConsumeRetry() {
			t.fail('shouldConsumeRetry should not fire');
		},
		retries: 5,
		minTimeout: 0,
	}));

	t.is(error, originalError);
	t.is(attempts, 1);
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

test('shouldConsumeRetry then onFailedAttempt then shouldRetry order', async t => {
	const order = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('order');
	}, {
		shouldConsumeRetry() {
			order.push('shouldConsumeRetry');
			return true;
		},
		onFailedAttempt() {
			order.push('onFailedAttempt');
		},
		shouldRetry() {
			order.push('shouldRetry');
			return false;
		},
	}));

	t.deepEqual(order, ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']);
});

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
	const contexts = [];

	// Matched on the TypeError, so an unrelated failure at the call site cannot pass this off as the
	// freeze working.
	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		onFailedAttempt(context) {
			contexts.push(context);
			Object.defineProperty(context, 'foo', {value: 'bar'});
		},
	}), {instanceOf: TypeError, message: /not extensible/});

	t.true(Object.isFrozen(contexts[0]));
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

test('throws on fractional retries', async t => {
	let inputCalled = false;

	await t.throwsAsync(pRetry(() => {
		inputCalled = true;
	}, {retries: 0.5}), {
		instanceOf: TypeError,
		message: 'Expected `retries` to be a non-negative integer or Infinity.',
	});

	t.false(inputCalled);
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
	for (const name of ['factor', 'minTimeout', 'maxTimeout', 'maxRetryTime']) {
		await t.throwsAsync(pRetry(async () => {}, {[name]: -1}), {
			instanceOf: TypeError,
			message: `Expected \`${name}\` to be ≥ 0.`,
		});
	}
});

test('non-number numeric options throw', async t => {
	for (const name of ['factor', 'minTimeout', 'maxTimeout', 'maxRetryTime']) {
		await t.throwsAsync(pRetry(async () => {}, {[name]: 'nope'}), {
			instanceOf: TypeError,
			message: new RegExp(`^Expected \`${name}\` to be a number`),
		});
	}
});

test('numeric options that only allow a finite value reject Infinity', async t => {
	for (const name of ['factor', 'minTimeout']) {
		await t.throwsAsync(pRetry(async () => {}, {[name]: Number.POSITIVE_INFINITY}), {
			instanceOf: TypeError,
			message: `Expected \`${name}\` to be a finite number.`,
		});
	}

	// These two take Infinity as their default, so it has to be allowed.
	for (const name of ['maxTimeout', 'maxRetryTime']) {
		await t.notThrowsAsync(pRetry(async () => fixture, {[name]: Number.POSITIVE_INFINITY, retries: 0}));
	}
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

test('unsupported `forever` option throws', async t => {
	// Deliberate: any own `forever` key is a migration mistake, even one carrying the old default.
	for (const forever of [true, false, undefined, null]) {
		await t.throwsAsync(pRetry(async () => {}, {forever}), {
			message: /no longer supported/,
		});
	}
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

test('stops after the first attempt when the input returns null', async t => {
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
	const observed = [];
	const maxAttempts = 4;

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: Number.POSITIVE_INFINITY,
		minTimeout: 0,
		onFailedAttempt(context) {
			observed.push(context.retriesLeft);
			if (observed.length >= maxAttempts) {
				throw new AbortError('stop');
			}
		},
	}));

	for (const retriesLeft of observed) {
		t.is(retriesLeft, Number.POSITIVE_INFINITY);
	}

	t.is(observed.length, maxAttempts);
});

test('shouldConsumeRetry receives normalized error for non-error throws', async t => {
	let shouldConsumeRetryContext;

	await t.throwsAsync(pRetry(async () => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}, {
		retries: 0,
		minTimeout: 0,
		shouldConsumeRetry(context) {
			shouldConsumeRetryContext = context;
			return true;
		},
	}), {
		message: /Non-error/,
	});

	t.true(shouldConsumeRetryContext.error instanceof TypeError);
});

test('shouldConsumeRetry returning false still respects retry budget', async t => {
	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 0,
		minTimeout: 0,
		shouldConsumeRetry: () => false,
	}), {message: 'fail'});

	t.is(attempts, 1);
});

test('shouldConsumeRetry returning false still calls shouldRetry', async t => {
	let attempts = 0;
	let shouldRetryCalls = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 0,
		shouldConsumeRetry: () => false,
		shouldRetry() {
			shouldRetryCalls++;
			return false;
		},
	}), {message: 'fail'});

	t.is(attempts, 1);
	t.is(shouldRetryCalls, 1);
});

test('shouldConsumeRetry sees retryDelay as 0 when retriesLeft is 0', async t => {
	let retryDelay;

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 0,
		minTimeout: 100,
		randomize: false,
		shouldConsumeRetry(context) {
			retryDelay = context.retryDelay;
			return true;
		},
	}));

	t.is(retryDelay, 0);
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

test.serial('retryDelay is zero when shouldConsumeRetry skips the retry', async t => {
	const retryDelays = [];

	await t.throwsAsync(pRetry(
		async () => {
			throw new Error('test');
		},
		{
			retries: 2,
			minTimeout: 100,
			randomize: false,
			shouldConsumeRetry: () => false,
			shouldRetry: () => false,
			onFailedAttempt({retryDelay}) {
				retryDelays.push(retryDelay);
			},
		},
	));

	t.deepEqual(retryDelays, [0]);
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

// Callback contract
test('callbacks are skipped or not based on the error type', async t => {
	const matrix = new Map([
		['plain Error', {error: new Error('boom'), expected: ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry', 'shouldConsumeRetry', 'onFailedAttempt']}],
		['non-network TypeError', {error: new TypeError('nope'), expected: ['shouldConsumeRetry', 'onFailedAttempt']}],
		['network TypeError', {error: new TypeError('fetch failed'), expected: ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry', 'shouldConsumeRetry', 'onFailedAttempt']}],
		['AbortError', {error: new AbortError('stop'), expected: []}],
	]);

	for (const [label, {error, expected}] of matrix) {
		const calls = [];

		await t.throwsAsync(pRetry(() => {
			throw error;
		}, {
			retries: 1,
			minTimeout: 0,
			shouldConsumeRetry() {
				calls.push('shouldConsumeRetry');
				return true;
			},
			onFailedAttempt() {
				calls.push('onFailedAttempt');
			},
			shouldRetry() {
				calls.push('shouldRetry');
				return true;
			},
		}));

		t.deepEqual(calls, expected, `${label}`);
	}
});

test('the operation error is preserved on every rejection path', async t => {
	const target = new Error('target');
	const scenarios = [
		[{retries: 1, minTimeout: 0}, () => {
			throw target;
		}],
		[{minTimeout: 0, shouldRetry: () => false}, () => {
			throw target;
		}],
		[{
			minTimeout: 0,
			shouldConsumeRetry: () => false,
			shouldRetry: () => false,
		}, () => {
			throw target;
		}],
		[{maxRetryTime: 0}, () => {
			throw target;
		}],
		[{minTimeout: 0}, () => {
			throw new AbortError(target);
		}],
		[{
			minTimeout: 0,
			onFailedAttempt() {
				throw target;
			},
		}, () => {
			throw new Error('something else');
		}],
	];

	for (const [options, input] of scenarios) {
		await t.throwsAsync(pRetry(input, options), {is: target});
	}
});

test('a non-Error abort reason is preserved verbatim', async t => {
	for (const reason of ['a string', 42, {custom: true}]) {
		const controller = new AbortController();
		let thrown;

		try {
			await pRetry(async () => {
				controller.abort(reason);
				return fixture;
			}, {signal: controller.signal});
		} catch (error) {
			thrown = error;
		}

		t.is(thrown, reason);
	}
});

test('a shared signal aborts every concurrent retry', async t => {
	const controller = new AbortController();

	const first = pRetry(async () => {
		controller.abort(fixtureError);
		throw new Error('first');
	}, {signal: controller.signal, minTimeout: 10_000});
	const second = pRetry(async () => {
		throw new Error('second');
	}, {signal: controller.signal, minTimeout: 10_000});

	for (const result of await Promise.allSettled([first, second])) {
		t.is(result.status, 'rejected');
		t.is(result.reason, fixtureError);
	}
});

test('each callback receives its own frozen context object', async t => {
	const contexts = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 1,
		minTimeout: 0,
		shouldConsumeRetry(context) {
			contexts.push(context);
			return true;
		},
		onFailedAttempt(context) {
			contexts.push(context);
		},
		shouldRetry(context) {
			contexts.push(context);
			return false;
		},
	}));

	t.is(contexts.length, 3);
	// `onFailedAttempt` and `shouldRetry` share one object; only `shouldConsumeRetry` gets its own.
	t.is(new Set(contexts).size, 2);
	t.is(contexts[1], contexts[2]);
	for (const context of contexts) {
		t.true(Object.isFrozen(context));
	}
});

test('retriesLeft and retriesConsumed always add up to retries', async t => {
	const retries = 4;
	const observations = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries,
		minTimeout: 0,
		shouldConsumeRetry({retriesLeft, retriesConsumed}) {
			observations.push([retriesLeft, retriesConsumed]);
			return true;
		},
		onFailedAttempt({retriesLeft, retriesConsumed}) {
			observations.push([retriesLeft, retriesConsumed]);
		},
	}));

	t.is(observations.length, 10);
	for (const [retriesLeft, retriesConsumed] of observations) {
		t.is(retriesLeft + retriesConsumed, retries);
	}
});

test('retryDelay is always a non-negative integer', async t => {
	const retryDelays = [];

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 5,
		minTimeout: 7,
		factor: 1.5,
		maxTimeout: 13,
		onFailedAttempt({retryDelay}) {
			retryDelays.push(retryDelay);
		},
	}));

	t.is(retryDelays.length, 6);
	for (const retryDelay of retryDelays) {
		t.true(Number.isInteger(retryDelay), `${retryDelay} is an integer`);
		t.true(retryDelay >= 0, `${retryDelay} is not negative`);
	}
});

test('maxRetryTime does not interrupt an attempt that is already running', async t => {
	const result = await pRetry(async () => {
		await delay(100);
		return fixture;
	}, {maxRetryTime: 10, retries: 0});

	t.is(result, fixture);
});

test('makeRetriable works without options', async t => {
	const retried = makeRetriable(() => fixture);
	t.is(await retried(), fixture);
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
