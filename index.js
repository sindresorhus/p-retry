'use strict';
const retry = require('retry');

class AbortError extends Error {
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

module.exports = (input, options) => new Promise((resolve, reject) => {
	options = Object.assign({
		onFailedAttempt: () => {},
		retries: 10
	}, options);

	const operation = retry.operation(options);
	const {retries} = options;

	operation.attempt(attemptNumber => {
		// minus 1 from attemptNumber because the first attempt does not count as a retry
		const retriesLeft = retries - (attemptNumber - 1);

		return Promise.resolve(attemptNumber)
			.then(input)
			.then(resolve, error => {
				if (error instanceof AbortError) {
					operation.stop();
					reject(error.originalError);
				} else if (error instanceof TypeError) {
					operation.stop();
					reject(error);
				} else if (operation.retry(error)) {
					error.attemptNumber = attemptNumber;
					error.retriesLeft = retriesLeft;
					options.onFailedAttempt(error);
				} else {
					error.attemptNumber = attemptNumber;
					error.retriesLeft = retriesLeft;
					options.onFailedAttempt(error);
					reject(operation.mainError());
				}
			});
	});
});

module.exports.AbortError = AbortError;
