import {OperationOptions} from 'retry';

declare class AbortErrorClass extends Error {
	readonly name: 'AbortError';
	readonly originalError: Error;

	/**
	Abort retrying and reject the promise.

	@param message - Error message or custom error.
	*/
	constructor(message: string | Error);
}

declare namespace pRetry {
	interface FailedAttemptError extends Error {
		readonly attemptNumber: number;
		readonly retriesLeft: number;
	}

	interface Options extends OperationOptions {
		/**
		Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `retriesLeft` which indicate the current attempt number and the number of attempts left, respectively.
		*/
		readonly onFailedAttempt?: (error: FailedAttemptError) => void;
	}

	type AbortError = AbortErrorClass;
}

declare const pRetry: {
	/**
	Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

	It doesn't retry on `TypeError` as that's a user error.

	@param input - Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.
	@param options - Options are passed to the [`retry`](https://github.com/tim-kos/node-retry#retryoperationoptions) module.

	@example
	```
	import pRetry = require('p-retry');
	import fetch from 'node-fetch';

	const run = async () => {
		const response = await fetch('https://sindresorhus.com/unicorn');

		// Abort retrying if the resource doesn't exist
		if (response.status === 404) {
			throw new pRetry.AbortError(response.statusText);
		}

		return response.blob();
	};

	(async () => {
		console.log(await pRetry(run, {retries: 5}));

		// With the `onFailedAttempt` option:
		const result = await pRetry(run, {
			onFailedAttempt: error => {
				console.log(`Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`);
				// 1st request => Attempt 1 failed. There are 4 retries left.
				// 2nd request => Attempt 2 failed. There are 3 retries left.
				// …
			},
			retries: 5
		});

		console.log(result);
	})();
	```
	*/
	<T>(
		input: (attemptCount: number) => PromiseLike<T> | T,
		options?: pRetry.Options
	): Promise<T>;

	AbortError: typeof AbortErrorClass;

	// TODO: remove this in the next major version
	default: typeof pRetry;
};

export = pRetry;
