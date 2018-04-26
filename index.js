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

	operation.attempt(attemptNumber => {
		const attemptsLeft = options.retries - attemptNumber;

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
					error.attemptsLeft = attemptsLeft;
					options.onFailedAttempt(error);
				} else {
					reject(operation.mainError());
				}
			});
	});
});

module.exports.AbortError = AbortError;
