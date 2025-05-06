export class AbortError extends Error {
	readonly name: 'AbortError';
	readonly originalError: Error;

	/**
	Abort retrying and reject the promise.

	@param message - An error message or a custom error.
	*/
	constructor(message: string | Error);
}

export type FailedAttemptError = {
	readonly attemptNumber: number;
	readonly retriesLeft: number;
} & Error;

export type Options = {
	/**
	Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `retriesLeft` which indicate the current attempt number and the number of attempts left, respectively.

	@example
	```
	import pRetry from 'p-retry';

	const run = async () => {
		const response = await fetch('https://sindresorhus.com/unicorn');

		if (!response.ok) {
			throw new Error(response.statusText);
		}

		return response.json();
	};

	const result = await pRetry(run, {
		onFailedAttempt: error => {
			console.log(`Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`);
			// 1st request => Attempt 1 failed. There are 5 retries left.
			// 2nd request => Attempt 2 failed. There are 4 retries left.
			// …
		},
		retries: 5
	});

	console.log(result);
	```

	The `onFailedAttempt` function can return a promise. For example, to add a [delay](https://github.com/sindresorhus/delay):

	@example
	```
	import pRetry from 'p-retry';
	import delay from 'delay';

	const run = async () => { … };

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
	Decide if a retry should occur based on the error. Returning true triggers a retry, false aborts with the error.

	It is not called for `TypeError` (except network errors) and `AbortError`.

	@param error - The error thrown by the input function.

	@example
	```
	import pRetry from 'p-retry';

	const run = async () => { … };

	const result = await pRetry(run, {
		shouldRetry: error => !(error instanceof CustomError);
	});
	```

	In the example above, the operation will be retried unless the error is an instance of `CustomError`.
	*/
	readonly shouldRetry?: (error: FailedAttemptError) => boolean | Promise<boolean>;

	/**
	The maximum amount of times to retry the operation.

	@default 10
	*/
	readonly retries?: number;

	/**
	The exponential factor to use.

	@default 2
	*/
	readonly factor?: number;

	/**
	The number of milliseconds before starting the first retry.

	@default 1000
	*/
	readonly minTimeout?: number;

	/**
	The maximum number of milliseconds between two retries.

	@default Infinity
	*/
	readonly maxTimeout?: number;

	/**
	Randomizes the timeouts by multiplying with a factor between 1 and 2.

	@default false
	*/
	readonly randomize?: boolean;

	/**
	The maximum time (in milliseconds) that the retried operation is allowed to run.

	@default Infinity
	*/
	readonly maxRetryTime?: number;

	/**
	You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

	```
	import pRetry from 'p-retry';

	const run = async () => { … };
	const controller = new AbortController();

	cancelButton.addEventListener('click', () => {
		controller.abort(new Error('User clicked cancel button'));
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

	/**
	Prevents retry timeouts from keeping the process alive.

	Only affects platforms with a `.unref()` method on timeouts, such as Node.js.

	@default false
	*/
	readonly unref?: boolean;
};

/**
Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this. See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

@param input - Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.
@param options - Options for configuring the retry behavior.

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
```
*/
export default function pRetry<T>(
	input: (attemptCount: number) => PromiseLike<T> | T,
	options?: Options
): Promise<T>;
