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
	const operation = retry.operation(opts);

	operation.attempt(attempts => {
		Promise.resolve(input)
			.then(input)
			.then(resolve, err => {
				if (err instanceof AbortError) {
					operation.stop();
					reject(err.originalError);
				} else if (err instanceof TypeError) {
					operation.stop();
					reject(err);
				} else if (!operation.retry(err)) {
					reject(operation.mainError());
				}
			});
	});
});

module.exports.AbortError = AbortError;
