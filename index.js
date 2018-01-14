/* eslint-disable unicorn/custom-error-definition */
'use strict';
const retry = require('retry');

class AbortError extends Error {
	constructor(message) {
		super();

		if (message instanceof Error) {
			this.originalError = message;
			message = message.message;
		} else {
			this.originalError = new Error(message);
			this.originalError.stack = this.stack;
		}

		this.name = 'AbortError';
		this.message = message;
	}
}

module.exports = (input, opts) => new Promise((resolve, reject) => {
	opts = Object.assign({
		onFailedAttempt: () => {},
		retries: 10
	}, opts);
	const operation = retry.operation(opts);
	const {onFailedAttempt, retries} = opts;

	operation.attempt(attemptNo => {
		const attemptsLeft = retries - attemptNo;
		return Promise.resolve(attemptNo)
			.then(input)
			.then(resolve, err => {
				if (err instanceof AbortError) {
					operation.stop();
					reject(err.originalError);
				} else if (err instanceof TypeError) {
					operation.stop();
					reject(err);
				} else if (operation.retry(err)) {
					onFailedAttempt(err, attemptNo, attemptsLeft);
				} else {
					reject(operation.mainError());
				}
			});
	});
});

module.exports.AbortError = AbortError;
