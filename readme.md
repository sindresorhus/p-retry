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

#### input

Type: `Function`

Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.

#### options

Type: `object`

##### onFailedAttempt(context)

Type: `Function`

Callback invoked on each retry. Receives a context object containing the error and retry state information.

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
	onFailedAttempt: ({error, attemptNumber, retriesLeft, skip, skippedRetries}) => {
		console.log(`Attempt ${attemptNumber} failed. There are ${retriesLeft} retries left. Skip? ${skip}. Total skipped: ${skippedRetries}.`);
		// 1st request => Attempt 1 failed. There are 5 retries left. Skip? false. Total skipped: 0.
		// 2nd request => Attempt 2 failed. There are 4 retries left. Skip? false. Total skipped: 0.
		// …
	},
	retries: 5
});

console.log(result);
```

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

If the `onFailedAttempt` function throws, all retries will be aborted and the original promise will reject with the thrown error.

##### shouldRetry(context)

Type: `Function`

Decide if a retry should occur based on the context. Returning true triggers a retry, false aborts with the error.

It is only called if `retries` and `maxRetryTime` have not been exhausted.

It is not called for `TypeError` (except network errors) and `AbortError`.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	shouldRetry: ({error, attemptNumber, retriesLeft, skip}) => !skip && !(error instanceof CustomError)
});
```

In the example above, the operation will be retried unless the error is an instance of `CustomError`.

##### shouldSkip(context)

Type: `Function`

Decide if an error should be "skipped".

Skipped errors do not consume retries or impact backoff, but still invoke `onFailedAttempt`.

Receives the same `context` object as `shouldRetry` and `onFailedAttempt`.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	retries: 2,
	shouldSkip: ({error, retriesLeft, skippedRetries}) => {
		console.log(`Retries left: ${retriesLeft}, skipped so far: ${skippedRetries}`);
		return error instanceof RateLimitError;
	},
});
```

In the example above, `RateLimitError`s will not count against the retry limit.

##### retries

Type: `number`\
Default: `10`

The maximum amount of times to retry the operation.

##### factor

Type: `number`\
Default: `2`

The exponential factor to use.

##### minTimeout

Type: `number`\
Default: `1000`

The number of milliseconds before starting the first retry.

##### maxTimeout

Type: `number`\
Default: `Infinity`

The maximum number of milliseconds between two retries.

##### randomize

Type: `boolean`\
Default: `false`

Randomizes the timeouts by multiplying with a factor between 1 and 2.

##### maxRetryTime

Type: `number`\
Default: `Infinity`

The maximum time (in milliseconds) that the retried operation is allowed to run.

##### signal

Type: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

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

Abort retrying and reject the promise.

### message

Type: `string`

An error message.

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

### How do I stop retries when the process receives SIGINT (Ctrl+C)?

Use an [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) to signal cancellation on SIGINT, and pass its `signal` to `pRetry`:

```js
import pRetry from 'p-retry';

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
