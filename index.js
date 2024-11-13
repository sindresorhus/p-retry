import retry from 'retry';
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

export default async function pRetry(input, options) {
	return new Promise((resolve, reject) => {
		options = {
			onFailedAttempt() {},
			retries: 10,
			shouldRetry: () => true,
			...options,
		};

		const operation = retry.operation(options);

		const abortHandler = () => {
			operation.stop();
			reject(options.signal?.reason);
		};

		if (options.signal && !options.signal.aborted) {
			options.signal.addEventListener('abort', abortHandler, {once: true});
		}

		const cleanUp = () => {
			options.signal?.removeEventListener('abort', abortHandler);
			operation.stop();
		};

		operation.attempt(async attemptNumber => {
			try {
				const result = await input(attemptNumber);
				cleanUp();
				resolve(result);
			} catch (error) {
				try {
					if (!(error instanceof Error)) {
						throw new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`);
					}

					if (error instanceof AbortError) {
						throw error.originalError;
					}

					if (error instanceof TypeError && !isNetworkError(error)) {
						throw error;
					}

					decorateErrorWithCounts(error, attemptNumber, options);

					if (!(await options.shouldRetry(error))) {
						operation.stop();
						reject(error);
					}

					if (typeof options.onFailedAttempt === 'function') {
						await options.onFailedAttempt(error);
					}

					if (!operation.retry(error)) {
						throw operation.mainError();
					}
				} catch (finalError) {
					decorateErrorWithCounts(finalError, attemptNumber, options);
					cleanUp();
					reject(finalError);
				}
			}
		});
	});
}
