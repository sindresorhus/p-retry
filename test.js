import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import {fixture, fixtureError, rejectsWith} from './helpers.js';
import pRetry, {makeRetriable, AbortError} from './index.js';

test('retries', {timeout: 60_000}, async () => {
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
	});

	assert.equal(returnValue, fixture);
	assert.equal(index, 3);
});

test('retries forever when specified', async () => {
	let attempts = 0;
	const maxAttempts = 15; // Limit for test purposes

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			if (attempts === maxAttempts) {
				throw new AbortError('stop');
			}

			throw new Error('test');
		},
		{
			retries: Infinity,
			minTimeout: 0, // Speed up test
		},
	));

	assert.equal(attempts, maxAttempts);
});

// Error Handling Tests

test('throws useful error message when non-error is thrown', async () => {
	await assert.rejects(pRetry(() => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}), {
		message: /Non-error/v,
	});
});

test('values that cannot be stringified still get a useful error message', async () => {
	// Interpolating these into the message throws, which would hide the real failure.
	const values = new Map([
		[Symbol('fixture'), 'Symbol(fixture)'],
		[Object.create(null), '[object Object]'],
		[{toString: null}, '[object Object]'],
	]);

	for (const [value, expected] of values) {
		await assert.rejects(pRetry(() => {
			throw value;
		}, {retries: 0}), {
			name: 'TypeError',
			message: `Non-error was thrown: "${expected}". You should only throw errors.`,
		});
	}
});

test('a throwing toString does not replace the reported failure', async () => {
	await assert.rejects(pRetry(() => {
		throw { // eslint-disable-line no-throw-literal
			toString() {
				throw new Error('toString exploded');
			},
		};
	}, {retries: 0}), {
		name: 'TypeError',
		message: /^Non-error was thrown/v,
	});
});

test('a value that cannot be converted at all still gets a useful error message', async () => {
	// A proxy can throw from the `Symbol.toStringTag` read that the fallback does, too.
	await assert.rejects(pRetry(() => {
		throw new Proxy({}, {
			get(target, property) {
				if (property === Symbol.toStringTag) {
					throw new Error('toStringTag exploded');
				}

				return Reflect.get(target, property);
			},
		});
	}, {retries: 0}), {
		name: 'TypeError',
		message: 'Non-error was thrown: "object". You should only throw errors.',
	});
});

test('no retry on TypeError', {timeout: 30_000}, async () => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let index = 0;

	await assert.rejects(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	}), rejectsWith(typeErrorFixture));

	assert.equal(index, 1);
});

test('a shouldConsumeRetry that returns nothing still consumes a retry', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
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
	assert.equal(attempts, 3);
});

test('shouldRetry is not called for non-network TypeError', async () => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let retryDecisionCount = 0; // A count, despite the name.

	await assert.rejects(pRetry(async () => {
		throw typeErrorFixture;
	}, {
		shouldRetry() {
			retryDecisionCount++;
			return true;
		},
	}), rejectsWith(typeErrorFixture));

	assert.equal(retryDecisionCount, 0);
});

test('async shouldRetry respects maxRetryTime after callback', async t => {
	const originalPerformanceNow = performance.now;
	let now = 0;

	// A controlled clock, so the budget cannot be spent before the callback is reached however loaded
	// the machine is. With a real 50ms budget, a slow worker exhausts it before `shouldRetry` runs and
	// the test passes without ever exercising the check that this is about.
	performance.now = () => now;

	t.after(() => {
		performance.now = originalPerformanceNow;
	});

	let attempts = 0;

	await assert.rejects(pRetry(async () => {
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

	assert.equal(attempts, 1);
});

test('a non-network TypeError is not retried whatever shouldConsumeRetry says', async () => {
	const typeErrorFixture = new TypeError('type-error-fixture');
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw typeErrorFixture;
	}, {
		shouldConsumeRetry() {
			return false;
		},
		retries: 5,
		minTimeout: 0,
	}), rejectsWith(typeErrorFixture));

	assert.equal(attempts, 1);
});

test('throws on non-boolean randomize and unref', async () => {
	// `randomize: 'false'` from an env var or a CLI flag is truthy, so it would turn jitter on.
	await assert.rejects(pRetry(async () => {}, {randomize: 'yes'}), {
		name: 'TypeError',
		message: 'Expected `randomize` to be a boolean.',
	});

	await assert.rejects(pRetry(async () => {}, {unref: 'yes'}), {
		name: 'TypeError',
		message: 'Expected `unref` to be a boolean.',
	});
});

test('throws on invalid callback options', async () => {
	await assert.rejects(pRetry(async () => {}, {
		onFailedAttempt: 1,
	}), {
		message: 'Expected `onFailedAttempt` to be a function.',
	});

	await assert.rejects(pRetry(async () => {}, {
		shouldRetry: 1,
	}), {
		message: 'Expected `shouldRetry` to be a function.',
	});

	await assert.rejects(pRetry(async () => {}, {
		shouldConsumeRetry: 1,
	}), {
		message: 'Expected `shouldConsumeRetry` to be a function.',
	});
});

test('retry on TypeError - failed to fetch', {timeout: 60_000}, async () => {
	const typeErrorFixture = new TypeError('Failed to fetch');
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	});

	assert.equal(returnValue, fixture);
	assert.equal(index, 3);
});

test('errors are preserved when maxRetryTime exceeded', {timeout: 30_000}, async () => {
	const originalError = new Error('original error');
	const maxRetryTime = 100;

	await assert.rejects(pRetry(
		async () => {
			await delay(maxRetryTime + 50); // Ensure we exceed maxRetryTime
			throw originalError;
		},
		{
			maxRetryTime,
			minTimeout: 0,
		},
	), rejectsWith(originalError));
});

test('shouldConsumeRetry runs before onFailedAttempt when maxRetryTime is exhausted', async () => {
	const order = [];
	const retryDelays = [];

	await assert.rejects(pRetry(async () => {
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
	assert.deepEqual(order, ['shouldConsumeRetry', 'onFailedAttempt']);
	assert.deepEqual(retryDelays, [0]);
});

test('retries: null uses the default', async () => {
	// Every option treats `null` as "not provided", so `retries` has to as well.
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: null,
		minTimeout: 0,
	}), {message: 'fail'});

	assert.equal(attempts, 11); // The default of 10 retries, plus the first attempt.
});

test('null option values use the defaults', async () => {
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
		// A rejected promise from `pRetry` is the failure, so the fixture coming back is the assertion.
		assert.equal(await pRetry(async () => fixture, options), fixture);
	}
});

test('shouldRetry controls retry behavior', {timeout: 60_000}, async () => {
	const retryError = new Error('should-retry');
	const customError = new Error('custom-error');
	let index = 0;

	await assert.rejects(pRetry(async () => {
		await delay(40);
		index++;
		const error = index < 3 ? retryError : customError;
		throw error;
	}, {
		async shouldRetry({error}) {
			return error.message === retryError.message;
		},
		retries: 10,
	}), rejectsWith(customError));

	assert.equal(index, 3);
});

test('shouldConsumeRetry then onFailedAttempt then shouldRetry order', async () => {
	const order = [];

	await assert.rejects(pRetry(async () => {
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

	assert.deepEqual(order, ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']);
});

test('onFailedAttempt provides correct error details', {timeout: 60_000}, async () => {
	const retries = 5;
	let index = 0;
	let failureCount = 0;

	await pRetry(
		async attemptNumber => {
			await delay(40);
			index++;
			return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
		},
		{
			onFailedAttempt({error, attemptNumber: attempt, retriesLeft}) {
				assert.equal(error, fixtureError);
				assert.equal(attempt, ++failureCount);
				assert.equal(retriesLeft, retries - (index - 1));
			},
			retries,
		},
	);

	assert.equal(index, 3);
	assert.equal(failureCount, 2);
});

test('onFailedAttempt is called even when shouldRetry returns false', async () => {
	const error = new Error('fail');
	let onFailedAttemptCount = 0;
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw error;
	}, {
		onFailedAttempt() {
			onFailedAttemptCount++;
		},
		shouldRetry: () => false,
		retries: 5,
	}), rejectsWith(error));

	assert.equal(attempts, 1);
	assert.equal(onFailedAttemptCount, 1);
});

test('onFailedAttempt can throw to abort retries', async () => {
	const error = new Error('thrown from onFailedAttempt');

	await assert.rejects(pRetry(async () => {
		throw fixtureError;
	}, {
		onFailedAttempt() {
			throw error;
		},
	}), rejectsWith(error));
});

test('retry context object is immutable', async () => {
	const contexts = [];

	// Matched on the TypeError, so an unrelated failure at the call site cannot pass this off as the
	// freeze working.
	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		onFailedAttempt(context) {
			contexts.push(context);
			Object.defineProperty(context, 'foo', {value: 'bar'});
		},
	}), {name: 'TypeError', message: /not extensible/v});

	assert.ok(Object.isFrozen(contexts[0]));
});

test('onFailedAttempt can be undefined', {timeout: 30_000}, async () => {
	const error = new Error('thrown from onFailedAttempt');

	await assert.rejects(pRetry(() => {
		throw error;
	}, {
		onFailedAttempt: undefined,
		retries: 1,
	}), rejectsWith(error));
});

test('shouldRetry can be undefined', {timeout: 30_000}, async () => {
	const error = new Error('thrown from onFailedAttempt');

	await assert.rejects(pRetry(() => {
		throw error;
	}, {
		shouldRetry: undefined,
		retries: 1,
	}), rejectsWith(error));
});

test('aborts immediately if signal is already aborted', async () => {
	const controller = new AbortController();
	controller.abort();

	// A default abort reason is a `DOMException`, but its `name` is `AbortError`, so check the class
	// rather than the name the way the other assertions do.
	await assert.rejects(
		pRetry(
			async () => {
				throw new Error('test');
			},
			{signal: controller.signal},
		),
		error => error instanceof DOMException,
	);
});

test('throws on negative retry count', async () => {
	await assert.rejects(
		pRetry(
			async () => {},
			{retries: -1},
		),
		{
			name: 'TypeError',
			message: 'Expected `retries` to be a non-negative number.',
		},
	);
});

test('throws on non-number retries', async () => {
	await assert.rejects(
		pRetry(
			async () => {},
			// @ts-expect-error - Intentionally wrong type for runtime validation
			{retries: '3'},
		),
		{
			name: 'TypeError',
			message: 'Expected `retries` to be a number or Infinity.',
		},
	);
});

test('throws on NaN retries', async () => {
	await assert.rejects(
		pRetry(
			async () => {},
			{retries: NaN},
		),
		{
			name: 'TypeError',
			message: 'Expected `retries` to be a valid number or Infinity, got NaN.',
		},
	);
});

test('throws on fractional retries', async () => {
	let isInputCalled = false;

	await assert.rejects(pRetry(() => {
		isInputCalled = true;
	}, {retries: 0.5}), {
		name: 'TypeError',
		message: 'Expected `retries` to be a non-negative integer or Infinity.',
	});

	assert.ok(!isInputCalled);
});

test('handles zero retries', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{retries: 0},
	));

	assert.equal(attempts, 1); // Should only try once with zero retries
});

test('onFailedAttempt still called when retries is zero', async () => {
	let onFailedAttemptCount = 0;

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: 0,
		onFailedAttempt() {
			onFailedAttemptCount++;
		},
	}));

	assert.equal(onFailedAttemptCount, 1);
});

test('invalid numeric options throw', async () => {
	for (const name of ['factor', 'minTimeout', 'maxTimeout', 'maxRetryTime']) {
		await assert.rejects(pRetry(async () => {}, {[name]: -1}), {
			name: 'TypeError',
			message: `Expected \`${name}\` to be ≥ 0.`,
		});
	}
});

test('non-number numeric options throw', async () => {
	for (const name of ['factor', 'minTimeout', 'maxTimeout', 'maxRetryTime']) {
		await assert.rejects(pRetry(async () => {}, {[name]: 'nope'}), {
			name: 'TypeError',
			message: new RegExp(`^Expected \`${name}\` to be a number`, 'v'),
		});
	}
});

test('numeric options that only allow a finite value reject Infinity', async () => {
	for (const name of ['factor', 'minTimeout']) {
		await assert.rejects(pRetry(async () => {}, {[name]: Infinity}), {
			name: 'TypeError',
			message: `Expected \`${name}\` to be a finite number.`,
		});
	}

	// These two take Infinity as their default, so it has to be allowed.
	for (const name of ['maxTimeout', 'maxRetryTime']) {
		await pRetry(async () => fixture, {[name]: Infinity, retries: 0});
	}
});

test('unsupported `forever` option throws', async () => {
	// Deliberate: any own `forever` key is a migration mistake, even one carrying the old default.
	for (const forever of [true, false, undefined, null]) {
		await assert.rejects(pRetry(async () => {}, {forever}), {
			message: /no longer supported/v,
		});
	}
});

test('handles zero maxRetryTime', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(
		async () => {
			attempts++;
			throw new Error('test');
		},
		{maxRetryTime: 0},
	));

	assert.equal(attempts, 1); // Should only try once with zero maxRetryTime
});

test('handles synchronous input function', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(
		() => { // Non-async function
			attempts++;
			throw new Error('test');
		},
		{retries: 2, minTimeout: 0},
	));

	assert.equal(attempts, 3); // Initial + 2 retries
});

test('stops after the first attempt when the input returns null', async () => {
	let attempts = 0;

	const result = await pRetry(
		() => {
			attempts++;
			return null;
		},
		{retries: 2},
	);

	assert.equal(attempts, 1); // Should stop after first success
	assert.equal(result, null);
});

test('handles non-Error rejection values', async () => {
	await assert.rejects(pRetry(
		() => Promise.reject('string rejection'), // eslint-disable-line prefer-promise-reject-errors
		{retries: 1, minTimeout: 0},
	), {
		message: /Non-error was thrown/v,
	});
});

test('makeRetriable wraps and retries the function', async () => {
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
	assert.equal(result, 5);
	assert.equal(callCount, 3);
});

test('makeRetriable passes arguments and options', async () => {
	let lastArguments;
	const function_ = (...arguments_) => {
		lastArguments = arguments_;
		throw new Error('fail');
	};

	const retried = makeRetriable(function_, {retries: 1, minTimeout: 0});
	await assert.rejects(() => retried('foo', 42));
	assert.deepEqual(lastArguments, ['foo', 42]);
});

test('makeRetriable preserves `this` context', async () => {
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
	assert.equal(result, 5);
	assert.equal(object.calls, 2);
});

test('throws error from shouldRetry', async () => {
	const thrown = new Error('shouldRetry failure');

	await assert.rejects(pRetry(async () => {
		throw new Error('operation failed');
	}, {
		shouldRetry() {
			throw thrown;
		},
	}), rejectsWith(thrown));
});

test('retriesLeft is Infinity when retries is Infinity', async () => {
	const observed = [];
	const maxAttempts = 4;

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		retries: Infinity,
		minTimeout: 0,
		onFailedAttempt(context) {
			observed.push(context.retriesLeft);
			if (observed.length >= maxAttempts) {
				throw new AbortError('stop');
			}
		},
	}));

	for (const retriesLeft of observed) {
		assert.equal(retriesLeft, Infinity);
	}

	assert.equal(observed.length, maxAttempts);
});

test('shouldConsumeRetry receives normalized error for non-error throws', async () => {
	let shouldConsumeRetryContext;

	await assert.rejects(pRetry(async () => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}, {
		retries: 0,
		minTimeout: 0,
		shouldConsumeRetry(context) {
			shouldConsumeRetryContext = context;
			return true;
		},
	}), {
		message: /Non-error/v,
	});

	assert.ok(shouldConsumeRetryContext.error instanceof TypeError);
});

test('shouldConsumeRetry returning false still respects retry budget', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 0,
		minTimeout: 0,
		shouldConsumeRetry: () => false,
	}), {message: 'fail'});

	assert.equal(attempts, 1);
});

test('shouldConsumeRetry returning false still calls shouldRetry', async () => {
	let attempts = 0;
	let retryDecisionCount = 0; // A count, despite the name.

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		retries: 3,
		minTimeout: 0,
		shouldConsumeRetry: () => false,
		shouldRetry() {
			retryDecisionCount++;
			return false;
		},
	}), {message: 'fail'});

	assert.equal(attempts, 1);
	assert.equal(retryDecisionCount, 1);
});

test('shouldConsumeRetry sees retryDelay as 0 when retriesLeft is 0', async () => {
	let retryDelay;

	await assert.rejects(pRetry(async () => {
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

	assert.equal(retryDelay, 0);
});

test('retryDelay is zero when shouldConsumeRetry skips the retry', async () => {
	const retryDelays = [];

	await assert.rejects(pRetry(
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

	assert.deepEqual(retryDelays, [0]);
});

// Callback contract

test('callbacks are skipped or not based on the error type', async () => {
	const matrix = new Map([
		['plain Error', {error: new Error('boom'), expected: ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry', 'shouldConsumeRetry', 'onFailedAttempt']}],
		['non-network TypeError', {error: new TypeError('nope'), expected: ['shouldConsumeRetry', 'onFailedAttempt']}],
		['network TypeError', {error: new TypeError('fetch failed'), expected: ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry', 'shouldConsumeRetry', 'onFailedAttempt']}],
		['AbortError', {error: new AbortError('stop'), expected: []}],
	]);

	for (const [label, {error, expected}] of matrix) {
		const calls = [];

		await assert.rejects(pRetry(() => {
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

		assert.deepEqual(calls, expected, label);
	}
});

test('the operation error is preserved on every rejection path', async () => {
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
		await assert.rejects(pRetry(input, options), rejectsWith(target));
	}
});

test('each callback receives its own frozen context object', async () => {
	const contexts = [];

	await assert.rejects(pRetry(async () => {
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

	assert.equal(contexts.length, 3);
	// `onFailedAttempt` and `shouldRetry` share one object; only `shouldConsumeRetry` gets its own.
	assert.equal(new Set(contexts).size, 2);
	assert.equal(contexts[1], contexts[2]);
	for (const context of contexts) {
		assert.ok(Object.isFrozen(context));
	}
});

test('retriesLeft and retriesConsumed always add up to retries', async () => {
	const retries = 4;
	const observations = [];

	await assert.rejects(pRetry(async () => {
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

	assert.equal(observations.length, 10);
	for (const [retriesLeft, retriesConsumed] of observations) {
		assert.equal(retriesLeft + retriesConsumed, retries);
	}
});

test('retryDelay is always a non-negative integer', {timeout: 30_000}, async () => {
	const retryDelays = [];

	await assert.rejects(pRetry(async () => {
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

	assert.equal(retryDelays.length, 6);
	for (const retryDelay of retryDelays) {
		// Not `Number.isSafeInteger`, which would reject a huge `retries` that is accepted on purpose.
		// eslint-disable-next-line unicorn/prefer-number-is-safe-integer
		assert.ok(Number.isInteger(retryDelay), `${retryDelay} is an integer`);
		assert.ok(retryDelay >= 0, `${retryDelay} is not negative`);
	}
});

test('maxRetryTime does not interrupt an attempt that is already running', {timeout: 30_000}, async () => {
	const result = await pRetry(async () => {
		await delay(100);
		return fixture;
	}, {maxRetryTime: 10, retries: 0});

	assert.equal(result, fixture);
});

test('the options object is not mutated', async () => {
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

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, options));

	assert.equal(JSON.stringify(options), before);

	// One shared options object across every call, so a normalization that wrote through would
	// change what the next call does. Each call must get its own initial attempt plus one retry.
	const shared = {retries: 1, minTimeout: 0};
	const failure = new Error('fail');
	let calls = 0;
	const retried = makeRetriable(async () => {
		calls++;
		throw failure;
	}, shared);

	await assert.rejects(() => retried(), rejectsWith(failure));
	assert.equal(calls, 2);

	await assert.rejects(() => retried(), rejectsWith(failure));
	assert.equal(calls, 4);

	assert.deepEqual(shared, {retries: 1, minTimeout: 0});
});

test('a rejected promise from a callback aborts the retries', async () => {
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
			async [name]() {
				throw thrown;
			},
		};

		await assert.rejects(pRetry(async () => {
			calls++;
			throw new Error('fail');
		}, options), rejectsWith(thrown));

		assert.equal(calls, 1, name);
	}
});

test('a callback may return a thenable', {timeout: 30_000}, async () => {
	let isResolved = false;
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
						isResolved = true;
						resolve();
					}, 10);
				},
			};
		},
	});

	// The retry only happened because the thenable was awaited first.
	assert.ok(isResolved);
	assert.equal(calls, 2);
});

test('concurrent calls through one retrier are independent', async () => {
	let attempts = 0;
	const retried = makeRetriable(async value => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return value * 2;
	}, {retries: 5, minTimeout: 0});

	assert.deepEqual(await Promise.all([retried(1), retried(2), retried(3)]), [2, 4, 6]);
});

test('NaN numeric options throw', async () => {
	const messages = {
		factor: 'Expected `factor` to be a number.',
		minTimeout: 'Expected `minTimeout` to be a number.',
		maxTimeout: 'Expected `maxTimeout` to be a number or Infinity.',
		maxRetryTime: 'Expected `maxRetryTime` to be a number or Infinity.',
	};

	// `NaN` is a number, so it needs its own check. The two options that take `Infinity` have nothing
	// later to catch it, and a `NaN` delay fires straight away.
	for (const [name, message] of Object.entries(messages)) {
		await assert.rejects(pRetry(async () => {}, {[name]: NaN}), {
			name: 'TypeError',
			message,
		});
	}
});

test('makeRetriable works without options', async () => {
	const retried = makeRetriable(() => fixture);
	assert.equal(await retried(), fixture);
});
