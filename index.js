import isNetworkError from 'is-network-error';

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

const decorateErrorWithCounts = (error, attemptNumber, options) => {
	// Minus 1 from attemptNumber because the first attempt does not count as a retry
	const retriesLeft = options.retries - (attemptNumber - 1);

	error.attemptNumber = attemptNumber;
	error.retriesLeft = retriesLeft;
	return error;
};

function calculateDelay(attempt, options) {
	const random = options.randomize ? (Math.random() + 1) : 1;

	let timeout = Math.round(random * Math.max(options.minTimeout, 1) * (options.factor ** (attempt - 1)));
	timeout = Math.min(timeout, options.maxTimeout);

	return timeout;
}

export default async function pRetry(input, options = {}) {
	options = {...options};
	options.retries ??= 10;
	options.factor ??= 2;
	options.minTimeout ??= 1000;
	options.maxTimeout ??= Number.POSITIVE_INFINITY;
	options.randomize ??= false;
	options.onFailedAttempt ??= () => {};
	options.shouldRetry ??= () => true;

	options.signal?.throwIfAborted();

	let attemptNumber = 0;
	const startTime = Date.now();

	const maxRetryTime = options.maxRetryTime ?? Number.POSITIVE_INFINITY;

	while (attemptNumber < options.retries + 1) {
		attemptNumber++;

		try {
			options.signal?.throwIfAborted();

			const result = await input(attemptNumber);

			options.signal?.throwIfAborted();

			return result;
		} catch (catchError) {
			let error = catchError;

			if (!(error instanceof Error)) {
				error = new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`);
			}

			if (error instanceof AbortError) {
				throw error.originalError;
			}

			if (error instanceof TypeError && !isNetworkError(error)) {
				throw error;
			}

			decorateErrorWithCounts(error, attemptNumber, options);

			// Always call onFailedAttempt
			await options.onFailedAttempt(error);

			const currentTime = Date.now();
			if (
				currentTime - startTime >= maxRetryTime
				|| attemptNumber >= options.retries + 1
				|| !(await options.shouldRetry(error))
			) {
				throw error; // Do not retry, throw the original error
			}

			// Calculate delay before next attempt
			const delayTime = calculateDelay(attemptNumber, options);

			// Ensure that delay does not exceed maxRetryTime
			const timeLeft = maxRetryTime - (currentTime - startTime);
			if (timeLeft <= 0) {
				throw error; // Max retry time exceeded
			}

			const finalDelay = Math.min(delayTime, timeLeft);

			// Introduce delay
			if (finalDelay > 0) {
				await new Promise((resolve, reject) => {
					const timeoutToken = setTimeout(resolve, finalDelay);

					options.signal?.addEventListener('abort', () => {
						clearTimeout(timeoutToken);
						reject(options.signal.reason);
					}, {once: true});
				});
			}

			options.signal?.throwIfAborted();
		}
	}

	// Should not reach here, but in case it does, throw an error
	throw new Error('Retry attempts exhausted without throwing an error.');
}
