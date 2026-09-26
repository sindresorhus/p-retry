import {getEventListeners} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import {fixture, fixtureError, rejectsWith} from './helpers.js';
import pRetry, {AbortError} from './index.js';

test('AbortError - string', () => {
	const error = new AbortError('fixture').originalError;
	assert.equal(error.constructor.name, 'Error');
	assert.equal(error.message, 'fixture');
});

test('AbortError - error', () => {
	const error = new AbortError(new Error('fixture')).originalError;
	assert.equal(error.constructor.name, 'Error');
	assert.equal(error.message, 'fixture');
});

test('AbortError - stack trace keeps the message', () => {
	// The thrown error is `originalError`, so its stack must still name the failure and point at the caller.
	const {stack} = new AbortError('fixture').originalError;
	assert.ok(stack.startsWith('Error: fixture'));
	assert.ok(stack.includes('new AbortError'));
	assert.ok(stack.includes('test-abort.js'));
});

test('AbortError - message is always a string', () => {
	// `Error` stringifies a non-string message, so `AbortError` must too.
	assert.equal(new AbortError(42).message, '42');
	assert.equal(new AbortError().message, '');
	assert.equal(new AbortError().message, new AbortError().originalError.message);
});

test('AbortSignal short-circuits callbacks', async () => {
	const controller = new AbortController();
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		controller.abort(fixtureError);
		return fixture;
	}, {
		signal: controller.signal,
		onFailedAttempt() {
			assert.fail('onFailedAttempt should not fire');
		},
		shouldRetry() {
			assert.fail('shouldRetry should not fire');
		},
		shouldConsumeRetry() {
			assert.fail('shouldConsumeRetry should not fire');
		},
	}), rejectsWith(fixtureError));

	assert.equal(attempts, 1);
});

test('aborting inside shouldConsumeRetry skips the later callbacks', async () => {
	const controller = new AbortController();
	const calls = [];

	await assert.rejects(pRetry(async () => {
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
	}), rejectsWith(fixtureError));

	assert.deepEqual(calls, ['shouldConsumeRetry']);
});

test('aborting inside onFailedAttempt skips shouldRetry', async () => {
	const controller = new AbortController();
	const calls = [];

	await assert.rejects(pRetry(async () => {
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
	}), rejectsWith(fixtureError));

	assert.deepEqual(calls, ['onFailedAttempt']);
});

test('a nested AbortError is unwrapped all the way down', async () => {
	// Left wrapped, the real cause would be buried and `error.name` would claim a cancellation.
	await assert.rejects(pRetry(async () => {
		throw new AbortError(new AbortError(fixtureError));
	}, {retries: 5, minTimeout: 0}), rejectsWith(fixtureError));
});

test('throws on an invalid signal', async () => {
	// Otherwise the failure surfaces as "options.signal?.throwIfAborted is not a function".
	for (const signal of [true, 'abort', {}, {throwIfAborted() {}, addEventListener() {}}]) {
		await assert.rejects(pRetry(async () => {}, {signal}), {
			name: 'TypeError',
			message: 'Expected `signal` to be an AbortSignal.',
		});
	}
});

test('an AbortError with an unusable originalError still rejects with an error', async () => {
	// `originalError` is writable, so it can be left pointing at nothing.
	const abortError = new AbortError('stop');
	abortError.originalError = undefined;

	await assert.rejects(pRetry(async () => {
		throw abortError;
	}, {retries: 5, minTimeout: 0}), rejectsWith(abortError));
});

test('aborting while the operation is in flight stops it without waiting out the delay', {timeout: 10_000}, async () => {
	const controller = new AbortController();
	const calls = [];

	setTimeout(() => {
		controller.abort(fixtureError);
	}, 20);

	await assert.rejects(pRetry(async () => {
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
	}), rejectsWith(fixtureError));

	assert.deepEqual(calls, []);
});

test('an AbortError that throws while being unwrapped still rejects with a real error', async () => {
	// `originalError` is writable, so a getter can throw, and a proxy can throw from
	// `getPrototypeOf`. Neither should be reported in place of the cause.
	const thrower = new AbortError('stop');
	Object.defineProperty(thrower, 'originalError', {
		configurable: true,
		get() {
			throw new Error('originalError exploded');
		},
	});

	const hostile = new Proxy(new AbortError('stop'), {
		getPrototypeOf() {
			throw new Error('getPrototypeOf exploded');
		},
	});

	let caught;

	try {
		await pRetry(async () => {
			throw thrower;
		}, {retries: 0});
	} catch (error) {
		caught = error;
	}

	// Nothing to unwrap to, so the wrapper itself is the answer.
	assert.equal(caught, thrower);

	// A proxy that throws from `getPrototypeOf` cannot be recognised as an error at all, so it goes
	// down the non-error path rather than reporting its own trap.
	caught = undefined;

	try {
		await pRetry(async () => {
			throw hostile;
		}, {retries: 0});
	} catch (error) {
		caught = error;
	}

	assert.equal(caught.message, 'Non-error was thrown: "AbortError: stop". You should only throw errors.');
});

test('a cycle in originalError does not hang', async () => {
	const outer = new AbortError('outer');
	const inner = new AbortError('inner');
	outer.originalError = inner;
	inner.originalError = outer;

	// A synchronous spin here would block the event loop, so the test would time out. Unwrapping
	// walks one link and then meets the cycle, so either wrapper is an acceptable result.
	await assert.rejects(pRetry(async () => {
		throw outer;
	}, {retries: 5, minTimeout: 0}), error => error === outer || error === inner);
});

test('a signal reason is not unwrapped, and wins over an AbortError', async () => {
	// The caller picks the reason for a cancellation, so it is final. Unwrapping it would replace the
	// reason they chose with whatever is inside it.
	const wrapped = new AbortError(fixtureError);
	const controller = new AbortController();

	await assert.rejects(pRetry(async () => {
		controller.abort(wrapped);
		throw new AbortError('from the operation');
	}, {
		signal: controller.signal,
		minTimeout: 0,
	}), rejectsWith(wrapped));

	// Cancelling wins over an AbortError the operation threw, since the caller asked to stop.
	const cancelled = new Error('caller cancelled');
	const second = new AbortController();

	await assert.rejects(pRetry(async () => {
		second.abort(cancelled);
		throw new AbortError(fixtureError);
	}, {
		signal: second.signal,
		minTimeout: 0,
	}), rejectsWith(cancelled));
});

test('a chain of wrappers that never ends does not hang', async () => {
	// A proxy can hand back a fresh wrapper on every read, so tracking the wrappers already seen
	// never matches and the walk spins on a synchronous loop, blocking the event loop.
	const lie = () => new Proxy(new AbortError('lying'), {
		get(target, property, receiver) {
			return property === 'originalError' ? lie() : Reflect.get(target, property, receiver);
		},
	});

	let thrown;

	try {
		await pRetry(async () => {
			throw lie();
		}, {retries: 0});
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown instanceof Error);
	assert.equal(thrown.message, 'lying');
});

test('aborts', {timeout: 60_000}, async () => {
	let index = 0;

	await assert.rejects(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? Promise.reject(new AbortError(fixtureError)) : Promise.reject(fixtureError);
	}), rejectsWith(fixtureError));

	assert.equal(index, 3);
});

test('operation stops immediately on AbortError', async () => {
	let attempts = 0;

	await assert.rejects(pRetry(
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
	), {message: 'stop'});

	assert.equal(attempts, 2); // Should stop after AbortError
});

test('shouldRetry is not called for AbortError', async () => {
	let retryDecisionCount = 0;

	await assert.rejects(pRetry(async () => {
		throw new AbortError('stop');
	}, {
		shouldRetry() {
			retryDecisionCount++;
			return true;
		},
	}), {message: 'stop'});

	assert.equal(retryDecisionCount, 0);
});

test('AbortError short-circuits callbacks', async () => {
	const originalError = new Error('stop');
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw new AbortError(originalError);
	}, {
		onFailedAttempt() {
			assert.fail('onFailedAttempt should not fire');
		},
		shouldRetry() {
			assert.fail('shouldRetry should not fire');
		},
		shouldConsumeRetry() {
			assert.fail('shouldConsumeRetry should not fire');
		},
		retries: 5,
		minTimeout: 0,
	}), rejectsWith(originalError));

	assert.equal(attempts, 1);
});

test('aborts with an AbortSignal', {timeout: 60_000}, async () => {
	let index = 0;
	const controller = new AbortController();

	// `pRetry` passes the attempt number itself, not an object holding it. Destructuring meant the
	// abort never fired and the run retried with exponential backoff until the timeout.
	await assert.rejects(
		pRetry(async attemptNumber => {
			await delay(40);
			index++;
			if (attemptNumber === 3) {
				controller.abort();
			}

			throw fixtureError;
		}, {
			signal: controller.signal,
		}),
		// A default abort reason is a `DOMException`, but its `name` is `AbortError`.
		error => error instanceof DOMException,
	);

	assert.equal(index, 3);
});

test('preserves the abort reason', {timeout: 60_000}, async () => {
	let index = 0;
	const controller = new AbortController();

	await assert.rejects(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		if (attemptNumber === 3) {
			controller.abort(fixtureError);
			return;
		}

		throw fixtureError;
	}, {
		signal: controller.signal,
	}), rejectsWith(fixtureError));

	assert.equal(index, 3);
});

test('aborts immediately if signal is already aborted with reason', async () => {
	let called = 0;
	const controller = new AbortController();
	controller.abort(fixtureError);

	await assert.rejects(pRetry(async () => {
		called++;
		throw new Error('should not run');
	}, {
		signal: controller.signal,
	}), rejectsWith(fixtureError));

	assert.equal(called, 0);
});

test('a non-Error abort reason is preserved verbatim', async () => {
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

		assert.equal(thrown, reason);
	}
});

test('a cancellation during shouldRetry is caught before the delay is set up', {timeout: 15_000}, async () => {
	// The check before `delayForRetry` is what keeps a cancellation prompt. Without it the delay
	// registers a listener on an already-aborted signal, which never fires, so the caller waits out
	// the whole backoff after asking to stop. A real timer is the point here: firing it immediately
	// would let the check after the delay catch the abort instead and prove nothing.
	const controller = new AbortController();
	const cancelled = new Error('cancelled');

	await assert.rejects(
		pRetry(async () => {
			throw new Error('operation failed');
		}, {
			signal: controller.signal,
			retries: 5,
			minTimeout: 60 * 60 * 1000,
			async shouldRetry() {
				controller.abort(cancelled);
				return true;
			},
		}),
		rejectsWith(cancelled),
	);
});

test('a cancellation is final whatever a callback returns', async () => {
	// Aborting inside a callback used to change the reported error depending on what that callback
	// returned, and the operation error could be discarded even when no retry was going to follow.
	for (const [abortIn, returnsTrue] of [
		['shouldConsumeRetry', true],
		['onFailedAttempt', undefined],
		['shouldRetry', true],
		['shouldRetry', false],
	]) {
		const controller = new AbortController();
		const options = {
			// One retry, so every callback under test is actually reached.
			retries: 1,
			signal: controller.signal,
			minTimeout: 0,
			[abortIn]() {
				controller.abort(fixtureError);
				return returnsTrue;
			},
		};

		await assert.rejects(pRetry(async () => {
			throw new Error('operation failed');
		}, options), rejectsWith(fixtureError), `${abortIn} returning ${returnsTrue}`);
	}
});

test('a shared signal aborts every concurrent retry', {timeout: 10_000}, async () => {
	const controller = new AbortController();
	let firstCalls = 0;
	let secondCalls = 0;

	// The first call is still mid-attempt when the second one aborts, so this covers the signal being
	// watched while a retry is already running rather than only the already-aborted-at-entry case.
	const first = pRetry(async () => {
		firstCalls++;
		await delay(20);
		throw new Error('first');
	}, {signal: controller.signal, minTimeout: 10_000});
	const second = pRetry(async () => {
		secondCalls++;
		controller.abort(fixtureError);
		throw new Error('second');
	}, {signal: controller.signal, minTimeout: 10_000});

	for (const result of await Promise.allSettled([first, second])) {
		assert.equal(result.status, 'rejected');
		assert.equal(result.reason, fixtureError);
	}

	// Both started, and neither got a second attempt.
	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 1);
});

test('AbortError is named and identifies itself as such', () => {
	// `name` is part of the public shape, and a log line that does not say what went wrong is worse
	// than one that does.
	assert.equal(new AbortError('fixture').name, 'AbortError');
	assert.equal(new AbortError(new Error('fixture')).name, 'AbortError');
	assert.equal(new (class AbortErrorSubclass extends AbortError {
		constructor() {
			super('fixture');
		}
	})().name, 'AbortError');
	assert.ok(new AbortError('fixture') instanceof Error);
});

test('the abort listener is removed once the delay is over', {timeout: 30_000}, async () => {
	// A signal that is reused across retries, or shared between calls, would otherwise collect one
	// stale listener per delay and eventually trip Node's max-listeners warning.
	const controller = new AbortController();

	for (let index = 0; index < 5; index++) {
		let calls = 0;
		await pRetry(async () => {
			calls++;
			if (calls > 1) {
				return fixture;
			}

			throw new Error('fail');
		}, {signal: controller.signal, minTimeout: 1, retries: 1});
	}

	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('the abort listener is removed when the delay is aborted', {timeout: 10_000}, async () => {
	const controller = new AbortController();

	setTimeout(() => {
		controller.abort(fixtureError);
	}, 5);

	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 5000,
	}), rejectsWith(fixtureError));

	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
