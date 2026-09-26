# p-retry

> Retry a promise-returning or async function

It does exponential backoff and supports custom retry strategies for failed operations.

## Install

```sh
npm install p-retry
```

## Usage

```js
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

## API

### pRetry(input, options?)

Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this. See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

Non-network `TypeError`s always abort retries, even if `shouldConsumeRetry` or `shouldRetry` would otherwise allow another attempt.

#### input

Type: `Function`

Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.

#### options

Type: `object`

##### onFailedAttempt(context)

Type: `Function`

Callback invoked on each failure. Receives a context object containing the error and retry state information.

The function is called _after_ `shouldConsumeRetry` and _before_ `shouldRetry`, for all errors _except_ `AbortError` and an abort through `signal`.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
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

The `context` object contains:
- `error` - The error that was thrown
- `attemptNumber` - The attempt number (starts at 1)
- `retriesLeft` - Number of retries remaining
- `retriesConsumed` - Number of retries consumed so far
- `retryDelay` - The delay in milliseconds before the next retry (based on `minTimeout`, `factor`, `maxTimeout`, and `randomize`). This is `0` when no retry will occur based on the checks completed before the current callback runs. `shouldConsumeRetry` is the exception: it is shown the delay that would be used, since deciding whether to consume the retry is what it is being asked.

The `onFailedAttempt` function can return a promise. For example, to add a [delay](https://github.com/sindresorhus/delay):

```js
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

##### shouldRetry(context)

Type: `Function`

Decide if a retry should occur based on context. Returning `true` triggers a retry, `false` aborts with the error. Returning nothing counts as `false`.

The function is called _after_ `onFailedAttempt` and `shouldConsumeRetry`.

The function is _not_ called on `AbortError`, on an abort through `signal`, on `TypeError` (except network errors), or if `retries` or `maxRetryTime` are exhausted.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	shouldRetry: ({error, attemptNumber, retriesLeft}) => !(error instanceof CustomError)
});
```

In the example above, the operation will be retried unless the error is an instance of `CustomError`.

##### shouldConsumeRetry(context)

Type: `Function`

Decide if this failure should consume a retry from the `retries` budget.

When `false` is returned, the failure will not consume a retry or increment backoff values, but is still subject to `maxRetryTime`. Returning nothing counts as `true`, the default, so `retries` stays the bound even if a callback forgets its `return`.

The retry is attempted straight away rather than after a delay, since no delay was accumulated.

The function is called _before_ `onFailedAttempt` and `shouldRetry`.

The function is _not_ called on `AbortError` or when the operation is aborted through `signal`.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	retries: 2,
	shouldConsumeRetry: ({error, retriesLeft}) => !(error instanceof RateLimitError),
});
```

In the example above, `RateLimitError`s will not decrement the available `retries`.

> [!WARNING]
> Failures that do not consume a retry also do not count towards `retries`, so returning `false` on every failure means `pRetry` never runs out of attempts. `maxRetryTime` is then the only bound, and it defaults to `Infinity`. Pair this option with `maxRetryTime`, or return `false` only for failures you expect to stop eventually. These retries also have no delay, so an operation that fails without waiting on a timer or I/O runs back to back without yielding to the event loop, and a `signal` aborted from a timer or an event cannot stop it.

##### retries

Type: `number`\
Default: `10`

The maximum amount of times to retry the operation. Must be a non-negative integer or `Infinity`.

##### factor

Type: `number`\
Default: `2`

The exponential factor to use.

A `factor` of `0` is treated as `1`, which keeps the delay constant. A `factor` below `1` shrinks the delay on every retry until it rounds to `0`, and from then on no timer is scheduled. See the warning on `minTimeout`.

##### minTimeout

Type: `number`\
Default: `1000`

The number of milliseconds before starting the first retry.

Set this to `0` to retry immediately with no delay.

> [!WARNING]
> A delay of `0` schedules no timer at all. If the operation also fails without waiting on a timer or I/O, attempts run back to back without ever yielding to the event loop. Combined with `retries: Infinity`, that is a busy loop that keeps the CPU pinned and stops timers, I/O, and `signal` from ever running. Use a small non-zero value if the operation can fail indefinitely.

##### maxTimeout

Type: `number`\
Default: `Infinity`

The maximum number of milliseconds between two retries.

Delays are also capped at the largest value a timer can hold, 2147483647ms, about 24.9 days. A longer one is clamped to that rather than firing straight away.

A `maxTimeout` below `1` millisecond rounds down to `0`. Like `minTimeout: 0`, this schedules no timer, so attempts run back to back without yielding to timers or timer-driven `signal` aborts. See the warning on `minTimeout`.

##### randomize

Type: `boolean`\
Default: `false`

Randomizes the timeouts by multiplying with a factor between 1 and 2.

##### maxRetryTime

Type: `number`\
Default: `Infinity`

The maximum time (in milliseconds) that retrying is allowed to take.

Measured with a monotonic clock (`performance.now()`) so system clock adjustments do not affect the limit.

The limit is checked after failed attempts and callbacks, before scheduling a retry. The retry delay is shortened to the remaining time, but the scheduled retry can still start after the limit. Attempts and callbacks are never interrupted, so they can run past the limit.

##### signal

Type: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

Once the signal is aborted, the abort reason is what the promise rejects with, whatever the operation threw and whatever the callbacks returned. A cancellation is the caller's decision and is not overwritten by a later failure.

The exception is a callback that throws or rejects: the boundary checks sit between the callbacks, so an error raised inside one is reported rather than replaced. An abort that lands before the callback is reached still wins.

```js
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

##### unref

Type: `boolean`\
Default: `false`

Prevents retry timeouts from keeping the process alive.

Only affects platforms with a `.unref()` method on timeouts, such as Node.js.

### makeRetriable(function, options?)

Wrap a function so that each call is automatically retried on failure.

```js
import {makeRetriable} from 'p-retry';

const fetchWithRetry = makeRetriable(fetch, {retries: 5});

const response = await fetchWithRetry('https://sindresorhus.com/unicorn');
```

### AbortError(message)
### AbortError(error)

Throw this from `input` to abort retrying and reject the promise. No callback functions will be called.

When `input` throws an `AbortError`, the promise rejects with the wrapped error. When you pass an error, a `catch` sees that error. When you pass a message, it sees a plain `Error` with that message. An `AbortError` thrown by a callback or passed as a `signal` abort reason is preserved as is.

### message

Type: `string`

An error message. Optional.

### error

Type: `Error`

A custom error.

## Tip

You can pass arguments to the function being retried by wrapping it in an inline arrow function:

```js
import pRetry from 'p-retry';

const run = async emoji => {
	// …
};

// Without arguments
await pRetry(run, {retries: 5});

// With arguments
await pRetry(() => run('🦄'), {retries: 5});
```

## FAQ

### How do I mock timers when testing with this package?

The package uses `setTimeout` and `clearTimeout` from the global scope, so you can use the [Node.js test timer mocking](https://nodejs.org/api/test.html#class-mocktimers) or a package like [`sinon`](https://github.com/sinonjs/sinon).

`maxRetryTime` is measured separately, with `performance.now()`. A fake timer that only replaces `setTimeout` leaves that clock running, so `maxRetryTime` is not reached while the mocked clock is. Fake `performance.now()` too if you are testing that option.

### How do I stop retries when the process receives SIGINT (Ctrl+C)?

Use an [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) to signal cancellation on SIGINT, and pass its `signal` to `pRetry`:

```js
import pRetry from 'p-retry';

const run = async () => { … };
const controller = new AbortController();

process.once('SIGINT', () => {
	controller.abort(new Error('SIGINT received'));
});

try {
	await pRetry(run, {signal: controller.signal});
} catch (error) {
	console.log('Retry stopped due to:', error.message);
}
```

The package does not handle process signals itself to avoid global side effects.

## Related

- [p-timeout](https://github.com/sindresorhus/p-timeout) - Timeout a promise after a specified amount of time
- [More…](https://github.com/sindresorhus/promise-fun)
