import {getEventListeners} from 'node:events';
import test from 'ava';
import delay from 'delay';
import {fixture, fixtureError} from './helpers.js';
import pRetry, {AbortError} from './index.js';

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

test('an AbortError that throws while being unwrapped still rejects with a real error', async t => {
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
	t.is(caught, thrower);

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

	t.is(caught.message, 'Non-error was thrown: "AbortError: stop". You should only throw errors.');
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

test('a signal reason is not unwrapped, and wins over an AbortError', async t => {
	// The caller picks the reason for a cancellation, so it is final. Unwrapping it would replace the
	// reason they chose with whatever is inside it.
	const wrapped = new AbortError(fixtureError);
	const controller = new AbortController();

	await t.throwsAsync(pRetry(async () => {
		controller.abort(wrapped);
		throw new AbortError('from the operation');
	}, {
		signal: controller.signal,
		minTimeout: 0,
	}), {is: wrapped});

	// Cancelling wins over an AbortError the operation threw, since the caller asked to stop.
	const cancelled = new Error('caller cancelled');
	const second = new AbortController();

	await t.throwsAsync(pRetry(async () => {
		second.abort(cancelled);
		throw new AbortError(fixtureError);
	}, {
		signal: second.signal,
		minTimeout: 0,
	}), {is: cancelled});
});

test('a chain of wrappers that never ends does not hang', async t => {
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

	// Not `t.throwsAsync`, which would have to structured-clone the proxy out of the AVA worker.
	t.true(thrown instanceof Error);
	t.is(thrown.message, 'lying');
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

test('a cancellation is final whatever a callback returns', async t => {
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

		await t.throwsAsync(pRetry(async () => {
			throw new Error('operation failed');
		}, options), {is: fixtureError}, `${abortIn} returning ${returnsTrue}`);
	}
});

test('a shared signal aborts every concurrent retry', async t => {
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
		t.is(result.status, 'rejected');
		t.is(result.reason, fixtureError);
	}

	// Both started, and neither got a second attempt.
	t.is(firstCalls, 1);
	t.is(secondCalls, 1);
});

test('AbortError is named and identifies itself as such', t => {
	// `name` is part of the public shape, and a log line that does not say what went wrong is worse
	// than one that does.
	t.is(new AbortError('fixture').name, 'AbortError');
	t.is(new AbortError(new Error('fixture')).name, 'AbortError');
	t.is(new (class AbortErrorSubclass extends AbortError {
		constructor() {
			super('fixture');
		}
	})().name, 'AbortError');
	t.true(new AbortError('fixture') instanceof Error);
});

test('the abort listener is removed once the delay is over', async t => {
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

	t.is(getEventListeners(controller.signal, 'abort').length, 0);
});

test('the abort listener is removed when the delay is aborted', async t => {
	const controller = new AbortController();

	setTimeout(() => {
		controller.abort(fixtureError);
	}, 5);

	await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 5000,
	}), {is: fixtureError});

	t.is(getEventListeners(controller.signal, 'abort').length, 0);
});
