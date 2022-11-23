import retry from 'retry';

const networkErrorMsgs = new Set([
	'Failed to fetch', // Chrome
	'NetworkError when attempting to fetch resource.', // Firefox
	'The Internet connection appears to be offline.', // Safari
	'Network request failed', // `cross-fetch`
	'fetch failed', // Undici (Node.js)
]);

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

const isNetworkError = errorMessage => networkErrorMsgs.has(errorMessage);

const getDOMException = errorMessage => globalThis.DOMException === undefined
	? new Error(errorMessage)
	: new DOMException(errorMessage);

export default async function pRetry(input, options) {
	return new Promise((resolve, reject) => {
		options = {
			onFailedAttempt() {},
			retries: 10,
			...options,
		};

		const operation = retry.operation(options);

		operation.attempt(async attemptNumber => {
			try {
				resolve(await input(attemptNumber));
			} catch (error) {
				if (!(error instanceof Error)) {
					reject(new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`));
					return;
				}

				if (error instanceof AbortError) {
					operation.stop();
					reject(error.originalError);
				} else if (error instanceof TypeError && !isNetworkError(error.message)) {
					operation.stop();
					reject(error);
				} else {
					decorateErrorWithCounts(error, attemptNumber, options);

					try {
						await options.onFailedAttempt(error);
					} catch (error) {
						reject(error);
						return;
					}

					if (!operation.retry(error)) {
						reject(operation.mainError());
					}
				}
			}
		});

		if (options.signal && !options.signal.aborted) {
			options.signal.addEventListener('abort', () => {
				operation.stop();
				const reason = options.signal.reason === undefined
					? getDOMException('The operation was aborted.')
					: options.signal.reason;
				reject(reason instanceof Error ? reason : getDOMException(reason));
			}, {
				once: true,
			});
		}
	});
}
