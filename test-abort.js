import process from 'node:process';
import {getEventListeners} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import {
	fixture,
	fixtureError,
	rejectsWith,
	withFakeTime,
} from './helpers.js';
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

test('AbortError - stack trace keeps the message and points at the caller', () => {
	// The thrown error is `originalError`, so its stack must still name the failure and point at the caller. A first frame inside p-retry would blame the library for an error the caller threw.
	const {stack} = new AbortError('fixture').originalError;
	const firstFrame = stack.split('\n', 2)[1];

	assert.ok(stack.startsWith('Error: fixture'));
	assert.match(firstFrame, /test-abort\.js/v);
});

test('AbortError - message is always a string', () => {
	// `Error` stringifies a non-string message, so `AbortError` must too.
	assert.equal(new AbortError(42).message, '42');
	assert.equal(new AbortError().message, '');
	assert.equal(new AbortError().message, new AbortError().originalError.message);
});

test('AbortError - works where the runtime cannot trim a stack', () => {
	// The stack trimming is V8-only, so a runtime without it must still get a usable error. Read through `Reflect` rather than as a property, because it is not part of the standard library.
	const original = Reflect.get(Error, 'captureStackTrace');
	Reflect.set(Error, 'captureStackTrace', undefined);

	try {
		const {message, stack} = new AbortError('fixture').originalError;
		assert.equal(message, 'fixture');
		assert.ok(stack.startsWith('Error: fixture'));
	} finally {
		Reflect.set(Error, 'captureStackTrace', original);
	}
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

test('aborting inside a callback stops the ones after it', async () => {
	// One matrix for the three callbacks. Each row aborts inside the named callback and names the callbacks that had already run, so both the rejection and the stopping point are checked.
	const matrix = new Map([
		['shouldConsumeRetry', ['shouldConsumeRetry']],
		['onFailedAttempt', ['shouldConsumeRetry', 'onFailedAttempt']],
		['shouldRetry', ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']],
	]);

	for (const [abortIn, expected] of matrix) {
		const controller = new AbortController();
		const calls = [];

		await assert.rejects(pRetry(async () => {
			throw new Error('fail');
		}, {
			signal: controller.signal,
			minTimeout: 0,
			async shouldConsumeRetry() {
				calls.push('shouldConsumeRetry');
				if (abortIn === 'shouldConsumeRetry') {
					controller.abort(fixtureError);
				}

				return true;
			},
			async onFailedAttempt() {
				calls.push('onFailedAttempt');
				if (abortIn === 'onFailedAttempt') {
					controller.abort(fixtureError);
				}
			},
			async shouldRetry() {
				calls.push('shouldRetry');
				if (abortIn === 'shouldRetry') {
					controller.abort(fixtureError);
				}

				return true;
			},
		}), rejectsWith(fixtureError), abortIn);

		assert.deepEqual(calls, expected, abortIn);
	}
});

test('a nested AbortError is unwrapped all the way down', async () => {
	// Left wrapped, the real cause would be buried and `error.name` would claim a cancellation.
	await assert.rejects(pRetry(async () => {
		throw new AbortError(new AbortError(fixtureError));
	}, {retries: 5, minTimeout: 0}), rejectsWith(fixtureError));
});

test('throws on an invalid signal', async () => {
	// Otherwise the failure surfaces as "options.signal?.throwIfAborted is not a function". One row per method the signal is duck typed on, so dropping any single check is caught. Each row has the other two and is missing only the one it is there to pin.
	for (const signal of [
		true,
		'string',
		{},
		{addEventListener() {}, removeEventListener() {}},
		{throwIfAborted() {}, removeEventListener() {}},
		{throwIfAborted() {}, addEventListener() {}},
	]) {
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

test('a cancellation wins over a TypeError that is never retried', async () => {
	// A non-network `TypeError` ends the run before any callback, but the abort check comes first, so the caller still gets the reason they chose.
	const controller = new AbortController();
	const reason = new Error('cancelled');

	await assert.rejects(pRetry(async () => {
		controller.abort(reason);
		throw new TypeError('operation failed');
	}, {
		signal: controller.signal,
		retries: 3,
		minTimeout: 0,
	}), error => error === reason);
});

test('a signal reason is not unwrapped, and wins over an AbortError', async () => {
	// The caller picks the reason for a cancellation, so it is final. Unwrapping it would replace the reason they chose with whatever is inside it.
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

// `shouldRetry` returns true, aborts, and spends the remaining budget. The budget check comes after it, so without the abort check right after `shouldRetry`, this would report the operation failure.
test('a cancellation is final even when the budget runs out inside shouldRetry', async () => {
	const originalPerformanceNow = performance.now;
	let now = 0;

	// A controlled clock. With a real 40ms budget, a worker descheduled for longer than that exhausts it before `shouldRetry` runs, so the abort never happens and the test passes without ever reaching the branch it is about.
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

test('aborts', async t => {
	await withFakeTime(t);
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

test('aborts with an AbortSignal', async t => {
	await withFakeTime(t);
	let index = 0;
	const controller = new AbortController();

	// The abort happens on the third attempt, so the run stops there and rejects with the default abort reason.
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

test('preserves the abort reason', async t => {
	await withFakeTime(t);
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
	// The check before `delayForRetry` is what keeps a cancellation prompt. Without it the delay registers a listener on an already-aborted signal, which never fires, so the caller waits out the whole backoff after asking to stop. A real timer is the point here: firing it immediately would let the check at the top of the next attempt catch the abort instead and prove nothing.
	const controller = new AbortController();
	const cancelled = new Error('cancelled');

	await assert.rejects(
		pRetry(async () => {
			throw new Error('operation failed');
		}, {
			signal: controller.signal,
			retries: 5,
			minTimeout: 60 * 60 * 1000,
			// The point of the hour is that a regression leaves that timer armed, which would stop the process exiting and turn a clean failure into a hang. `unref` keeps the wait pending while letting the process go once the test itself has failed.
			unref: true,
			async shouldRetry() {
				controller.abort(cancelled);
				return true;
			},
		}),
		rejectsWith(cancelled),
	);
});

test('an abort that lands after the delay stops the next attempt', {timeout: 10_000}, async t => {
	// The delay resolves from its timer, and the retry resumes in a promise microtask. A `nextTick` callback runs before that microtask, so this aborts in the window between the delay and the next attempt, which is the only thing the check at the top of the loop guards. Without it, the aborted attempt still runs.
	const controller = new AbortController();
	const cancelled = new Error('cancelled');
	const originalSetTimeout = setTimeout;
	const retryDelay = 17; // Not a delay any other timer in this test asks for.
	let isArmed = false;
	let attempts = 0;

	globalThis.setTimeout = (function_, ms, ...rest) => {
		if (!isArmed || ms !== retryDelay) {
			return originalSetTimeout(function_, ms, ...rest);
		}

		isArmed = false;

		return originalSetTimeout(() => {
			function_();
			process.nextTick(() => {
				controller.abort(cancelled);
			});
		}, ms, ...rest);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	await assert.rejects(pRetry(async () => {
		attempts++;
		isArmed = true;
		throw new Error('operation failed');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: retryDelay,
		factor: 1,
	}), rejectsWith(cancelled));

	assert.equal(attempts, 1, 'the retry after the abort never ran');
});

test('an abort does not interrupt an attempt that is already running', async () => {
	const controller = new AbortController();
	const {promise, resolve} = Promise.withResolvers();

	const attempt = pRetry(async () => {
		// Settles only when the test says so, the way a request that ignores the signal would.
		await promise;
		return fixture;
	}, {signal: controller.signal, retries: 1});

	controller.abort(fixtureError);

	// The retry cannot settle before `resolve`, so the timer always wins while the attempt is still running.
	const outcome = await Promise.race([
		attempt.then(() => 'settled').catch(() => 'settled'),
		delay(20).then(() => 'pending'),
	]);

	assert.equal(outcome, 'pending', 'the abort does not interrupt the attempt');

	// Once the attempt settles, the abort reason is what the retry rejects with.
	resolve(fixture);
	await assert.rejects(attempt, rejectsWith(fixtureError));
});

test('a cancellation is final whatever a callback returns', async () => {
	// The reported error must not depend on what the callback returned, including when no retry was going to follow.
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

test('a cancellation is final when the failure does not consume a retry', {timeout: 15_000}, async () => {
	// `shouldConsumeRetry` returned false, so no delay follows and the run goes straight back to the loop for the next attempt. The abort lands while `shouldRetry` is waiting, so it must be caught before that next attempt starts.
	const controller = new AbortController();
	const cancelled = new Error('cancelled');
	let attempts = 0;

	await assert.rejects(pRetry(async () => {
		attempts++;
		throw new Error('operation failed');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 0,
		shouldConsumeRetry: () => false,
		async shouldRetry() {
			await delay(20);
			controller.abort(cancelled);
			return true;
		},
	}), rejectsWith(cancelled));

	// The abort is caught before a second attempt starts.
	assert.equal(attempts, 1);
});

test('a callback that throws is reported even when the signal is already aborted', async () => {
	// The boundary checks sit between the callbacks, so an error raised inside one is not replaced by the abort reason. The docs say so, so it is pinned here rather than left to be inferred.
	//
	// Only the callback under test aborts. Aborting in an earlier one would be caught at the boundary before this one is reached, which is the other half of what the docs say.
	for (const name of ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']) {
		const controller = new AbortController();
		const thrown = new Error(`from ${name}`);

		await assert.rejects(pRetry(async () => {
			throw new Error('operation failed');
		}, {
			signal: controller.signal,
			minTimeout: 0,
			async shouldConsumeRetry() {
				if (name === 'shouldConsumeRetry') {
					controller.abort(fixtureError);
					throw thrown;
				}

				return true;
			},
			async onFailedAttempt() {
				if (name !== 'onFailedAttempt') {
					return;
				}

				controller.abort(fixtureError);
				throw thrown;
			},
			async shouldRetry() {
				if (name === 'shouldRetry') {
					controller.abort(fixtureError);
					throw thrown;
				}

				return true;
			},
		}), rejectsWith(thrown), name);
	}
});

test('an AbortError thrown by a callback is preserved and stops the ones after it', async () => {
	// The docs promise a callback's `AbortError` is preserved as is, which also means the callbacks after it do not run.
	const matrix = new Map([
		['shouldConsumeRetry', ['shouldConsumeRetry']],
		['onFailedAttempt', ['shouldConsumeRetry', 'onFailedAttempt']],
		['shouldRetry', ['shouldConsumeRetry', 'onFailedAttempt', 'shouldRetry']],
	]);

	for (const [abortIn, expected] of matrix) {
		const abortError = new AbortError(`from ${abortIn}`);
		const calls = [];

		const options = {
			retries: 2,
			minTimeout: 0,
			shouldConsumeRetry() {
				calls.push('shouldConsumeRetry');
				if (abortIn === 'shouldConsumeRetry') {
					throw abortError;
				}

				return true;
			},
			onFailedAttempt() {
				calls.push('onFailedAttempt');
				if (abortIn === 'onFailedAttempt') {
					throw abortError;
				}
			},
			shouldRetry() {
				calls.push('shouldRetry');
				if (abortIn === 'shouldRetry') {
					throw abortError;
				}

				return true;
			},
		};

		await assert.rejects(pRetry(async () => {
			throw new Error('fail');
		}, options), error => error === abortError, abortIn);

		assert.deepEqual(calls, expected, abortIn);
	}
});

test('AbortError keeps the error it is given', () => {
	// The caller's own error is what a `catch` sees, so it has to be the same object rather than a copy.
	const original = new Error('mine');
	assert.equal(new AbortError(original).originalError, original);
});

test('a shared signal aborts every concurrent retry', {timeout: 10_000}, async () => {
	const controller = new AbortController();
	let firstCalls = 0;
	let secondCalls = 0;

	// The first call is still mid-attempt when the second one aborts, so this covers the signal being watched while a retry is already running rather than only the already-aborted-at-entry case.
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
	// `name` is part of the public shape, and a log line that does not say what went wrong is worse than one that does.
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
	// A signal that is reused across retries, or shared between calls, would otherwise collect one stale listener per delay and eventually trip Node's max-listeners warning.
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
	let listenersDuringDelay;

	setTimeout(() => {
		listenersDuringDelay = getEventListeners(controller.signal, 'abort').length;
		controller.abort(fixtureError);
	}, 5);

	// The delay is a minute, so the rejection can only come from the listener, not from waiting it out. `unref` keeps a regression from also holding the process open for that minute.
	await assert.rejects(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 60_000,
		unref: true,
	}), rejectsWith(fixtureError));

	assert.equal(listenersDuringDelay, 1, 'the delay listens for the abort');
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
