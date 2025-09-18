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

function calculateDelay(context, options) {
	const attempt = Math.max(1, context.attemptNumber - context.skippedRetries);
	const random = options.randomize ? (Math.random() + 1) : 1;

	let timeout = Math.round(random * Math.max(options.minTimeout, 1) * (options.factor ** (attempt - 1)));
	timeout = Math.min(timeout, options.maxTimeout);

	return timeout;
}

function normalizeError(error) {
	if (!(error instanceof Error)) {
		return new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`);
	}

	if (error instanceof AbortError) {
		throw error.originalError;
	}

	if (error instanceof TypeError && !isNetworkError(error)) {
		throw error;
	}

	return error;
}

async function onAttemptFailure(context, options) {
	const {error: normalizedError, startTime, maxRetryTime} = context;

	if (normalizedError instanceof TypeError && !isNetworkError(normalizedError)) {
		throw normalizedError;
	}

	await options.onFailedAttempt(context);

	const currentTime = Date.now();
	const timeElapsed = currentTime - startTime;
	const timeLeft = maxRetryTime - timeElapsed;

	if (
		timeLeft <= 0
		|| (!context.skip && context.retriesLeft <= 0)
		|| !(await options.shouldRetry(context))
	) {
		throw normalizedError;
	}

	if (!context.skip) {
		const delayTime = calculateDelay(context, options);
		const finalDelay = Math.min(delayTime, timeLeft);

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
	options.shouldSkip ??= () => false;

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
	let retriesUsed = 0;
	const startTime = Date.now();
	const maxRetryTime = resolvedMaxRetryTime;
	const totalRetries = options.retries;

	const createRetryContext = async ({error, attemptNumber, retriesUsed}) => {
		const normalizedError = normalizeError(error);
		const retriesLeft = Number.isFinite(totalRetries)
			? Math.max(0, totalRetries - retriesUsed)
			: totalRetries;
		const skippedRetries = Math.max(0, (attemptNumber - 1) - retriesUsed);
		const context = {
			error: normalizedError,
			attemptNumber,
			retriesLeft,
			skippedRetries,
			skip: false,
			startTime,
			maxRetryTime,
		};

		try {
			context.skip = await options.shouldSkip(Object.freeze({...context}));
		} catch (error) {
			await onAttemptFailure(Object.freeze({...context}), options);
			throw error;
		}

		if (context.skip) {
			context.skippedRetries++;
		}

		return Object.freeze(context);
	};

	while (Number.isFinite(totalRetries) ? retriesUsed <= totalRetries : true) {
		attemptNumber++;

		try {
			options.signal?.throwIfAborted();

			const result = await input(attemptNumber);

			options.signal?.throwIfAborted();

			return result;
		} catch (error) {
			const context = await createRetryContext({error, attemptNumber, retriesUsed});
			await onAttemptFailure(context, options);
			if (!context.skip) {
				retriesUsed++;
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
