import test from 'ava';
import delay from 'delay';
import {fixture, fixtureError} from './helpers.js';
import pRetry, {makeRetriable, AbortError} from './index.js';

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

test.serial('async shouldRetry respects maxRetryTime after callback', async t => {
	const originalPerformanceNow = performance.now;
	let now = 0;

	// A controlled clock, so the budget cannot be spent before the callback is reached however loaded
	// the machine is. With a real 50ms budget, a slow worker exhausts it before `shouldRetry` runs and
	// the test passes without ever exercising the check that this is about.
	performance.now = () => now;

	t.teardown(() => {
		performance.now = originalPerformanceNow;
	});

	let attempts = 0;

	await t.throwsAsync(pRetry(async () => {
		attempts++;
		now += 10; // The operation itself.
		throw new Error('fail');
	}, {
		retries: 5,
		maxRetryTime: 50,
		async shouldRetry() {
			now += 100; // The callback, which is what has to exhaust the budget.
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

test('the options object is not mutated', async t => {
	// `pRetry` normalizes the options it is given, so writing through to the caller's object would
	// change the behaviour of the next call. `makeRetriable` shares one object across all of its calls.
	const options = {
		retries: 2,
		factor: 0.5,
		minTimeout: 0,
		maxTimeout: 5,
		randomize: false,
	};
	const before = JSON.stringify(options);

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, options));

	t.is(JSON.stringify(options), before);

	const shared = {retries: 1, minTimeout: 0};
	const retried = makeRetriable(async () => {
		throw new Error('fail');
	}, shared);

	await t.throwsAsync(() => retried());
	await t.throwsAsync(() => retried());

	t.deepEqual(shared, {retries: 1, minTimeout: 0});
});

test('a rejected promise from a callback aborts the retries', async t => {
	// The existing coverage only throws synchronously; an async callback rejects the same way.
	for (const name of ['onFailedAttempt', 'shouldConsumeRetry', 'shouldRetry']) {
		const thrown = new Error(`from ${name}`);
		let calls = 0;
		const options = {
			retries: 5,
			minTimeout: 0,
			async onFailedAttempt() {},
			async shouldRetry() {},
			async shouldConsumeRetry() {},
		};

		options[name] = async () => {
			throw thrown;
		};

		await t.throwsAsync(pRetry(async () => {
			calls++;
			throw new Error('fail');
		}, options), {is: thrown});

		t.is(calls, 1, `${name}`);
	}
});

test('a callback may return a thenable', async t => {
	let resolved = false;
	let calls = 0;

	await pRetry(async () => {
		calls++;
		if (calls > 1) {
			return fixture;
		}

		throw new Error('fail');
	}, {
		minTimeout: 0,
		onFailedAttempt() {
			return {
				then(resolve) { // eslint-disable-line unicorn/no-thenable -- A callback may return anything promise-like.
					setTimeout(() => {
						resolved = true;
						resolve();
					}, 10);
				},
			};
		},
	});

	// The retry only happened because the thenable was awaited first.
	t.true(resolved);
	t.is(calls, 2);
});

test('concurrent calls through one retrier are independent', async t => {
	let attempts = 0;
	const retried = makeRetriable(async value => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return value * 2;
	}, {retries: 5, minTimeout: 0});

	t.deepEqual(await Promise.all([retried(1), retried(2), retried(3)]), [2, 4, 6]);
});

test('NaN numeric options throw', async t => {
	const messages = {
		factor: 'Expected `factor` to be a number.',
		minTimeout: 'Expected `minTimeout` to be a number.',
		maxTimeout: 'Expected `maxTimeout` to be a number or Infinity.',
		maxRetryTime: 'Expected `maxRetryTime` to be a number or Infinity.',
	};

	// `NaN` is a number, so it needs its own check. The two options that take `Infinity` have nothing
	// later to catch it, and a `NaN` delay fires straight away.
	for (const [name, message] of Object.entries(messages)) {
		await t.throwsAsync(pRetry(async () => {}, {[name]: Number.NaN}), {
			instanceOf: TypeError,
			message,
		});
	}
});

test('makeRetriable works without options', async t => {
	const retried = makeRetriable(() => fixture);
	t.is(await retried(), fixture);
});

