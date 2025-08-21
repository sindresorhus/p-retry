import isNetworkError from 'is-network-error';

function validateRetries(retries) {
	if (typeof retries === 'number') {
		if (retries < 0) {
			throw new TypeError('Expected `retries` to be a non-negative number.');
		}

		if (Number.isNaN(retries)) {
			throw new TypeError('Expected `retries` to be a valid number or Infinity, got NaN.');
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

export class AbortError extends Error {
	constructor(message) {
		super();

		if (message instanceof Error) {
			this.originalError = message;
			({message} = message);
		} else {
			this.originalError = new Error(message);
			this.originalError.stack = this.stack;
		}

		this.name = 'AbortError';
		this.message = message;
	}
}

const createRetryContext = (error, attemptNumber, options) => {
	// Minus 1 from attemptNumber because the first attempt does not count as a retry
	const retriesLeft = options.retries - (attemptNumber - 1);

	return Object.freeze({
		error,
		attemptNumber,
		retriesLeft,
	});
};

function calculateDelay(attempt, options) {
	const random = options.randomize ? (Math.random() + 1) : 1;

	let timeout = Math.round(random * Math.max(options.minTimeout, 1) * (options.factor ** (attempt - 1)));
	timeout = Math.min(timeout, options.maxTimeout);

	return timeout;
}

async function onAttemptFailure(error, attemptNumber, options, startTime, maxRetryTime) {
	let normalizedError = error;

	if (!(normalizedError instanceof Error)) {
		normalizedError = new TypeError(`Non-error was thrown: "${normalizedError}". You should only throw errors.`);
	}

	if (normalizedError instanceof AbortError) {
		throw normalizedError.originalError;
	}

	if (normalizedError instanceof TypeError && !isNetworkError(normalizedError)) {
		throw normalizedError;
	}

	const context = createRetryContext(normalizedError, attemptNumber, options);

	// Always call onFailedAttempt
	await options.onFailedAttempt(context);

	const currentTime = Date.now();
	if (
		currentTime - startTime >= maxRetryTime
		|| attemptNumber >= options.retries + 1
		|| !(await options.shouldRetry(context))
	) {
		throw normalizedError; // Do not retry, throw the original error
	}

	// Calculate delay before next attempt
	const delayTime = calculateDelay(attemptNumber, options);

	// Ensure that delay does not exceed maxRetryTime
	const timeLeft = maxRetryTime - (currentTime - startTime);
	if (timeLeft <= 0) {
		throw normalizedError; // Max retry time exceeded
	}

	const finalDelay = Math.min(delayTime, timeLeft);

	// Introduce delay
	if (finalDelay > 0) {
		await new Promise((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timeoutToken);
				options.signal?.removeEventListener('abort', onAbort);
				reject(options.signal.reason);
			};

			const timeoutToken = setTimeout(() => {
				options.signal?.removeEventListener('abort', onAbort);
				resolve();
			}, finalDelay);

			if (options.unref) {
				timeoutToken.unref?.();
			}

			options.signal?.addEventListener('abort', onAbort, {once: true});
		});
	}

	options.signal?.throwIfAborted();
}

export default async function pRetry(input, options = {}) {
	options = {...options};

	validateRetries(options.retries);

	if (Object.hasOwn(options, 'forever')) {
		throw new Error('The `forever` option is no longer supported. For many use-cases, you can set `retries: Infinity` instead.');
	}

	options.retries ??= 10;
	options.factor ??= 2;
	options.minTimeout ??= 1000;
	options.maxTimeout ??= Number.POSITIVE_INFINITY;
	options.randomize ??= false;
	options.onFailedAttempt ??= () => {};
	options.shouldRetry ??= () => true;

	// Validate numeric options and normalize edge cases
	validateNumberOption('factor', options.factor, {min: 0, allowInfinity: false});
	validateNumberOption('minTimeout', options.minTimeout, {min: 0, allowInfinity: false});
	validateNumberOption('maxTimeout', options.maxTimeout, {min: 0, allowInfinity: true});
	const resolvedMaxRetryTime = options.maxRetryTime ?? Number.POSITIVE_INFINITY;
	validateNumberOption('maxRetryTime', resolvedMaxRetryTime, {min: 0, allowInfinity: true});

	// Treat non-positive factor as 1 to avoid zero backoff or negative behavior
	if (!(options.factor > 0)) {
		options.factor = 1;
	}

	options.signal?.throwIfAborted();

	let attemptNumber = 0;
	const startTime = Date.now();

	// Use validated local value
	const maxRetryTime = resolvedMaxRetryTime;

	while (attemptNumber < options.retries + 1) {
		attemptNumber++;

		try {
			options.signal?.throwIfAborted();

			const result = await input(attemptNumber);

			options.signal?.throwIfAborted();

			return result;
		} catch (error) {
			await onAttemptFailure(error, attemptNumber, options, startTime, maxRetryTime);
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
