import isNetworkError from 'is-network-error';

function validateRetries(retries) {
	if (typeof retries === 'number') {
		if (retries < 0) {
			throw new TypeError('Expected `retries` to be a non-negative number.');
		}

		if (Number.isNaN(retries)) {
			throw new TypeError('Expected `retries` to be a valid number or Infinity, got NaN.');
		}

		if (Number.isFinite(retries) && !Number.isInteger(retries)) {
			throw new TypeError('Expected `retries` to be a non-negative integer or Infinity.');
		}
	} else if (retries !== undefined) {
		throw new TypeError('Expected `retries` to be a number or Infinity.');
	}
}

function validateNumberOption(name, value, {min = 0, allowInfinity = false} = {}) {
	if (value === undefined) {
		return;
	}

	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new TypeError(`Expected \`${name}\` to be a number${allowInfinity ? ' or Infinity' : ''}.`);
	}

	if (!allowInfinity && !Number.isFinite(value)) {
		throw new TypeError(`Expected \`${name}\` to be a finite number.`);
	}

	if (value < min) {
		throw new TypeError(`Expected \`${name}\` to be \u2265 ${min}.`);
	}
}

function validateOption(name, value, type) {
	// `null` means "not provided", as it does for the other options. `unref` needs this because it is
	// the one option with no default of its own.
	if (value === undefined || value === null) {
		return;
	}

	if (typeof value !== type) {
		throw new TypeError(`Expected \`${name}\` to be a ${type}.`);
	}
}

function validateSignal(value) {
	// `null` means "not provided", as it does for the other options.
	if (value === undefined || value === null) {
		return;
	}

	// Duck typed rather than `instanceof`, so a signal from another realm still works. All three
	// methods are checked because `removeEventListener` is called from inside a timer callback, where
	// a `TypeError` would be an uncaught exception rather than a rejection the caller could catch.
	if (typeof value.throwIfAborted !== 'function'
		|| typeof value.addEventListener !== 'function'
		|| typeof value.removeEventListener !== 'function') {
		throw new TypeError('Expected `signal` to be an AbortSignal.');
	}
}

export class AbortError extends Error {
	constructor(message) {
		super(typeof message === 'string' ? message : undefined);

		this.name = 'AbortError';

		if (message instanceof Error) {
			this.originalError = message;
			({message} = message);
		} else {
			// Created here, so it already captures every caller frame. Copying `this.stack` instead would
			// only rewrite the header, which is rendered lazily from `name` and `message` at read time.
			// It also stringifies a non-string message, so reuse its result below.
			this.originalError = new Error(message);
			({message} = this.originalError);
		}

		this.message = message;
	}
}

// `setTimeout` cannot represent a longer delay and fires it right away instead, which turns a long
// backoff into a tight retry loop. Cap at the largest value it can still hold.
const maximumDelay = (2 ** 31) - 1;

function calculateDelay(retriesConsumed, options) {
	// Nothing to wait for, and multiplying by a factor that has grown to `Infinity` would give `NaN`.
	if (options.minTimeout === 0) {
		return 0;
	}

	const attempt = Math.max(1, retriesConsumed + 1);
	const random = options.randomize ? (Math.random() + 1) : 1;

	const timeout = Math.round(random * options.minTimeout * (options.factor ** (attempt - 1)));

	return Math.min(timeout, options.maxTimeout, maximumDelay);
}

function calculateRemainingTime(start, max) {
	if (!Number.isFinite(max)) {
		return max;
	}

	return max - (performance.now() - start);
}

async function delayForRetry(delay, options) {
	if (delay <= 0) {
		return;
	}

	await new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeoutToken);
			options.signal?.removeEventListener('abort', onAbort);
			reject(options.signal.reason);
		};

		const timeoutToken = setTimeout(() => {
			options.signal?.removeEventListener('abort', onAbort);
			resolve();
		}, delay);

		if (options.unref) {
			timeoutToken.unref?.();
		}

		options.signal?.addEventListener('abort', onAbort, {once: true});
	});
}

// Stringifying a thrown value can itself throw, for a symbol or an object with a broken `toString`.
// That must never be allowed to replace the failure the caller is actually dealing with.
function stringifyThrownValue(value) {
	try {
		return String(value);
	} catch {}

	try {
		return Object.prototype.toString.call(value);
	} catch {}

	// A proxy can throw on `Symbol.toStringTag` too, so the type is the last thing always safe.
	return typeof value;
}

// `AbortError` wraps the error the caller actually wants, and the wrappers can be nested, so keep
// unwrapping until the cause is reached. Otherwise an `AbortError` would escape `pRetry` and a
// `catch` doing `error instanceof AbortError` would read a real failure as a cancellation.
function unwrapAbortError(error) {
	let cause = error;
	// `originalError` is writable, so it can point back into the chain. Track what has been seen so
	// that a cycle stops here rather than spinning on a synchronous loop.
	const seen = new Set([cause]);

	while (cause instanceof AbortError) {
		const {originalError} = cause;

		if (!(originalError instanceof Error) || seen.has(originalError)) {
			break;
		}

		seen.add(originalError);
		cause = originalError;
	}

	return cause;
}

async function onAttemptFailure({error, attemptNumber, retriesConsumed, startTime, options}) {
	// Every boundary between callbacks is a place the caller can cancel from, so check at each one.
	const abortIfNeeded = () => {
		options.signal?.throwIfAborted();
	};

	const normalizedError = error instanceof Error
		? error
		: new TypeError(`Non-error was thrown: "${stringifyThrownValue(error)}". You should only throw errors.`);

	if (normalizedError instanceof AbortError) {
		throw unwrapAbortError(normalizedError);
	}

	// An aborted operation never got a chance to fail, so no callback should run for it.
	abortIfNeeded();

	const retriesLeft = Number.isFinite(options.retries)
		? Math.max(0, options.retries - retriesConsumed)
		: options.retries;

	const maxRetryTime = options.maxRetryTime ?? Number.POSITIVE_INFINITY;
	// Out of time already, so the callbacks must be told that no retry follows.
	const timeLeft = calculateRemainingTime(startTime, maxRetryTime);
	const delayTime = timeLeft > 0 ? calculateDelay(retriesConsumed, options) : 0;

	const consumeRetryContext = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: retriesLeft > 0 ? delayTime : 0,
	});

	// No answer means no opinion, so fall back to the default. Treating it as `false` instead would
	// leave `retries` uncounted and let the loop run forever.
	const consumeRetry = (await options.shouldConsumeRetry(consumeRetryContext)) ?? true;

	abortIfNeeded();

	const effectiveDelay = consumeRetry && retriesLeft > 0 ? delayTime : 0;
	const context = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: effectiveDelay,
	});

	await options.onFailedAttempt(context);

	abortIfNeeded();

	const remainingTime = calculateRemainingTime(startTime, maxRetryTime);

	if (remainingTime <= 0 || retriesLeft <= 0) {
		throw normalizedError;
	}

	if (normalizedError instanceof TypeError && !isNetworkError(normalizedError)) {
		throw normalizedError;
	}

	if (!await options.shouldRetry(context)) {
		throw normalizedError;
	}

	const remainingTimeAfterShouldRetry = calculateRemainingTime(startTime, maxRetryTime);

	if (remainingTimeAfterShouldRetry <= 0) {
		throw normalizedError;
	}

	if (!consumeRetry) {
		abortIfNeeded();
		return false;
	}

	const finalDelay = Math.min(effectiveDelay, remainingTimeAfterShouldRetry);

	abortIfNeeded();

	await delayForRetry(finalDelay, options);

	abortIfNeeded();

	return true;
}

export default async function pRetry(input, options = {}) {
	options = {...options};

	// Applied before validating, so that `null` means "not provided" here as it does for every other option.
	options.retries ??= 10;

	validateRetries(options.retries);

	if (Object.hasOwn(options, 'forever')) {
		throw new Error('The `forever` option is no longer supported. For many use-cases, you can set `retries: Infinity` instead.');
	}

	options.factor ??= 2;
	options.minTimeout ??= 1000;
	options.maxTimeout ??= Number.POSITIVE_INFINITY;
	options.maxRetryTime ??= Number.POSITIVE_INFINITY;
	options.randomize ??= false;
	options.onFailedAttempt ??= () => {};
	options.shouldRetry ??= () => true;
	options.shouldConsumeRetry ??= () => true;

	// Validate the options that have a runtime type to check.
	validateOption('onFailedAttempt', options.onFailedAttempt, 'function');
	validateOption('shouldRetry', options.shouldRetry, 'function');
	validateOption('shouldConsumeRetry', options.shouldConsumeRetry, 'function');
	validateOption('randomize', options.randomize, 'boolean');
	validateOption('unref', options.unref, 'boolean');
	validateSignal(options.signal);
	validateNumberOption('factor', options.factor, {min: 0, allowInfinity: false});
	validateNumberOption('minTimeout', options.minTimeout, {min: 0, allowInfinity: false});
	validateNumberOption('maxTimeout', options.maxTimeout, {min: 0, allowInfinity: true});
	validateNumberOption('maxRetryTime', options.maxRetryTime, {min: 0, allowInfinity: true});

	// Treat non-positive factor as 1 to avoid zero backoff or negative behavior
	if (!(options.factor > 0)) {
		options.factor = 1;
	}

	options.signal?.throwIfAborted();

	let attemptNumber = 0;
	let retriesConsumed = 0;
	const startTime = performance.now();

	while (Number.isFinite(options.retries) ? retriesConsumed <= options.retries : true) {
		attemptNumber++;

		try {
			options.signal?.throwIfAborted();

			const result = await input(attemptNumber);

			options.signal?.throwIfAborted();

			return result;
		} catch (error) {
			if (await onAttemptFailure({
				error,
				attemptNumber,
				retriesConsumed,
				startTime,
				options,
			})) {
				retriesConsumed++;
			}
		}
	}

	// Should not reach here, but in case it does, throw an error
	throw new Error('Retry attempts exhausted without throwing an error.');
}

export function makeRetriable(function_, options) {
	return function (...arguments_) {
		return pRetry(() => function_.apply(this, arguments_), options);
	};
}
