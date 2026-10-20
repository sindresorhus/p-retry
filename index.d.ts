export class AbortError extends Error {
	readonly name: 'AbortError';
	readonly originalError: Error;

	/**
	Throw this from `input` to abort retrying and reject the promise. No callback functions will be called.

	When `input` throws an `AbortError`, the promise rejects with the wrapped error. When you pass an error, a `catch` sees that error. When you pass a message, it sees a plain `Error` with that message. An `AbortError` thrown by a callback or passed as a `signal` abort reason is preserved as is.

	@param message - An error message or a custom error.
	*/
	constructor(message?: string | Error);
}

export type RetryContext = {
	readonly error: Error;
	readonly attemptNumber: number;
	readonly retriesLeft: number;
	readonly retriesConsumed: number;

	/**
	The delay in milliseconds before the next retry attempt.

	This is calculated based on `minTimeout`, `factor`, `maxTimeout`, and `randomize` options.

	Note: The actual delay may be shorter if it would exceed `maxRetryTime`.
	This is `0` when no retry will occur based on the checks completed before the current callback runs. `shouldConsumeRetry` is the exception: it is shown the delay that would be used, since deciding whether to consume the retry is what it is being asked.
	*/
	readonly retryDelay: number;
};

export type Options = {
	/**
	Callback invoked on each failure. Receives a context object containing the error and retry state information.

	The function is called after `shouldConsumeRetry` and before `shouldRetry`, for all errors except `AbortError` and an abort through `signal`.

	The function is not called on `AbortError` or when the operation is aborted through `signal`.

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
		onFailedAttempt: ({error, attemptNumber, retriesLeft, retriesConsumed, retryDelay}) => {
			console.log(`Attempt ${attemptNumber} failed. Retrying in ${retryDelay}ms. ${retriesLeft} retries left.`);
			// 1st request => Attempt 1 failed. Retrying in 1000ms. 5 retries left.
			// 2nd request => Attempt 2 failed. Retrying in 2000ms. 4 retries left.
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
		onFailedAttempt: async () => {
			console.log('Waiting for 1 second before retrying');
			await delay(1000);
		}
	});
	```

	If the `onFailedAttempt` function throws, all retries will be aborted and the original promise will reject with the thrown error.
	*/
	readonly onFailedAttempt?: ((context: RetryContext) => void | Promise<void>) | undefined;

	/**
	Decide if a retry should occur based on the context. Returning true triggers a retry, false aborts with the error. Returning nothing counts as `false`.

	The function is called after `onFailedAttempt` and `shouldConsumeRetry`.

	The function is not called on `AbortError`, on an abort through `signal`, on `TypeError` (except network errors), or if `retries` or `maxRetryTime` are exhausted.

	@example
	```
	import pRetry from 'p-retry';

	const run = async () => { … };

	const result = await pRetry(run, {
		shouldRetry: ({error, attemptNumber, retriesLeft}) => !(error instanceof CustomError)
	});
	```

	In the example above, the operation will be retried unless the error is an instance of `CustomError`.

	If the `shouldRetry` function throws, all retries will be aborted and the original promise will reject with the thrown error.
	*/
	readonly shouldRetry?: ((context: RetryContext) => boolean | Promise<boolean>) | undefined;

	/**
	Decide if this failure should consume a retry from the `retries` budget.

	When `false` is returned, the failure will not consume a retry or increment backoff values, but is still subject to `maxRetryTime`. Returning nothing counts as `true`, the default, so `retries` stays the bound even if a callback forgets its `return`.

	The retry is attempted straight away rather than after a delay, since no delay was accumulated.

	The function is called before `onFailedAttempt` and `shouldRetry`.

	The function is not called on `AbortError` or when the operation is aborted through `signal`.

	@example
	```
	import pRetry from 'p-retry';

	const run = async () => { … };

	const result = await pRetry(run, {
		retries: 2,
		shouldConsumeRetry: ({error, retriesLeft}) => {
			console.log(`Retries left: ${retriesLeft}`);
			return !(error instanceof RateLimitError);
		},
		maxRetryTime: 60_000,
	});
	```

	In the example above, `RateLimitError`s will not decrement the available `retries`, so `maxRetryTime` is what ends the run if the rate limit never clears.

	> [!WARNING]
	> Failures that do not consume a retry also do not count towards `retries`, so returning `false` on every failure means `pRetry` never runs out of attempts. `maxRetryTime` is then the only bound, and it defaults to `Infinity`. Pair this option with `maxRetryTime`, or return `false` only for failures you expect to stop eventually. These retries also have no delay, so an operation that fails without waiting on a timer or I/O runs back to back without yielding to the event loop, and a `signal` aborted from a timer or an event cannot stop it.

	If the `shouldConsumeRetry` function throws, all retries will be aborted and the original promise will reject with the thrown error.
	*/
	readonly shouldConsumeRetry?: ((context: RetryContext) => boolean | void | Promise<boolean | void>) | undefined;

	/**
	The maximum amount of times to retry the operation. Must be a non-negative integer or `Infinity`.

	@default 10
	*/
	readonly retries?: number | undefined;

	/**
	The exponential factor to use.

	A `factor` of `0` is treated as `1`, which keeps the delay constant. A `factor` below `1` shrinks the delay on every retry until it rounds to `0`, and from then on no timer is scheduled. See the warning on `minTimeout`.

	@default 2
	*/
	readonly factor?: number | undefined;

	/**
	The number of milliseconds before starting the first retry.

	Set this to `0` to retry immediately with no delay.

	A delay is a whole number of milliseconds, so a `minTimeout` below `0.5` makes the first delay `0` and schedules no timer for it. `randomize` scales the delay up by between 1 and 2, and a `factor` above `1` grows later delays, so either can push a delay back above the threshold.

	> [!WARNING]
	> A delay of `0` schedules no timer at all. If the operation also fails without waiting on a timer or I/O, attempts run back to back without ever yielding to the event loop. Combined with `retries: Infinity`, that is a busy loop that keeps the CPU pinned and stops timers, I/O, and `signal` from ever running. Use a small non-zero value if the operation can fail indefinitely.

	@default 1000
	*/
	readonly minTimeout?: number | undefined;

	/**
	The maximum number of milliseconds between two retries.

	Delays are also capped at the largest value a timer can hold, 2147483647ms, about 24.9 days. A longer one is clamped to that rather than firing straight away.

	A fractional `maxTimeout` rounds up to a whole millisecond. A `maxTimeout` of `0` schedules no timer, like `minTimeout: 0`. See the warning on `minTimeout`.

	@default Infinity
	*/
	readonly maxTimeout?: number | undefined;

	/**
	Randomizes the timeouts by multiplying with a factor between 1 and 2.

	@default false
	*/
	readonly randomize?: boolean | undefined;

	/**
	The maximum time (in milliseconds) that retrying is allowed to take.

	@default Infinity

	Measured with a monotonic clock (`performance.now()`) so system clock adjustments do not affect the limit.

	The limit is checked after failed attempts and callbacks, before scheduling a retry. The retry delay is shortened to the remaining time, but the scheduled retry can still start after the limit. Attempts and callbacks are never interrupted, so they can run past the limit.
	*/
	readonly maxRetryTime?: number | undefined;

	/**
	You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

	Once the signal is aborted, the abort reason is what the promise rejects with, whatever the operation threw and whatever the callbacks returned. A cancellation is the caller's decision and is not overwritten by a later failure. If the signal is already aborted, `input` is never called.

	An attempt that is already running is not interrupted, so the promise rejects when it settles. Pass the signal to the operation as well if the operation itself should be cancelled.

	The exception is a callback that throws or rejects: the boundary checks sit between the callbacks, so an error raised inside one is reported rather than replaced. An abort that lands before the callback is reached still wins.

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
	readonly signal?: AbortSignal | undefined;

	/**
	Prevents retry timeouts from keeping the process alive.

	Only affects platforms with a `.unref()` method on timeouts, such as Node.js.

	@default false
	*/
	readonly unref?: boolean | undefined;
};

/**
Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this. See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

Non-network `TypeError`s always abort retries, even if `shouldConsumeRetry` or `shouldRetry` would otherwise allow another attempt.

@param input - Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.
@param options - Options for configuring the retry behavior.

@example
```
import pRetry, {AbortError} from 'p-retry';

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
	input: (attemptNumber: number) => PromiseLike<T> | T,
	options?: Options,
): Promise<T>;

/**
Wrap a function so that each call is automatically retried on failure.

The wrapped function is called with the `this` the wrapper was called with, so a function that declares a `this` type keeps it.

@example
```
import {makeRetriable} from 'p-retry';

const fetchWithRetry = makeRetriable(fetch, {retries: 5});

const response = await fetchWithRetry('https://sindresorhus.com/unicorn');
```
*/
export function makeRetriable<Arguments extends readonly unknown[], Result, This = unknown>(
	function_: (this: This, ...arguments_: Arguments) => PromiseLike<Result> | Result,
	options?: Options,
): (this: This, ...arguments_: Arguments) => Promise<Result>;
