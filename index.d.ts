import {OperationOptions} from 'retry';

export class AbortError extends Error {
	readonly name: 'AbortError';
	readonly originalError: Error;

	/**
	Abort retrying and reject the promise.

	@param message - An error message or a custom error.
	*/
	constructor(message: string | Error);
}

export interface FailedAttemptError extends Error {
	readonly attemptNumber: number;
	readonly retriesLeft: number;
}

export interface Options extends OperationOptions {
	/**
	Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `retriesLeft` which indicate the current attempt number and the number of attempts left, respectively.

	The `onFailedAttempt` function can return a promise. For example, to add a [delay](https://github.com/sindresorhus/delay):

	```
	import pRetry from 'p-retry';
	import delay from 'delay';

	const run = async () => { ... };

	const result = await pRetry(run, {
		onFailedAttempt: async error => {
			console.log('Waiting for 1 second before retrying');
			await delay(1000);
		}
	});
	```

	If the `onFailedAttempt` function throws, all retries will be aborted and the original promise will reject with the thrown error.
	*/
	readonly onFailedAttempt?: (error: FailedAttemptError) => void | Promise<void>;

	/**
	You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

	When `AbortController.abort(reason)` is called, the promise will be rejected with `reason` as the error message.

	*Requires Node.js 16 or later.*

	```
	import pRetry from 'p-retry';

	const run = async () => { … };
	const controller = new AbortController();

	cancelButton.addEventListener('click', () => {
		controller.abort('User clicked cancel button');
	});

	try {
		await pRetry(run, {signal: controller.signal});
	} catch (error) {
		console.log(error.message);
		//=> 'User clicked cancel button'
	}
	```
	*/
	readonly signal?: AbortSignal;
}

/**
Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this.
See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

@param input - Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.
@param options - Options are passed to the [`retry`](https://github.com/tim-kos/node-retry#retryoperationoptions) module.

@example
```
import pRetry, {AbortError} from 'p-retry';
import fetch from 'node-fetch';

const run = async () => {
	const response = await fetch('https://sindresorhus.com/unicorn');

	// Abort retrying if the resource doesn't exist
	if (response.status === 404) {
		throw new AbortError(response.statusText);
	}

	return response.blob();
};

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
```
*/
export default function pRetry<T>(
	input: (attemptCount: number) => PromiseLike<T> | T,
	options?: Options
): Promise<T>;
