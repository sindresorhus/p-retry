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

## API

### pRetry(input, options?)

Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this. See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

#### input

Type: `Function`

Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.

#### options

Type: `object`

##### onFailedAttempt(error)

Type: `Function`

Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `retriesLeft` which indicate the current attempt number and the number of attempts left, respectively.

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

```js
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

##### shouldRetry(error)

Type: `Function`

Decide if a retry should occur based on the error. Returning true triggers a retry, false aborts with the error.

It is not called for `TypeError` (except network errors) and `AbortError`.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	shouldRetry: error => !(error instanceof CustomError);
});
```

In the example above, the operation will be retried unless the error is an instance of `CustomError`.

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

## Related

- [p-timeout](https://github.com/sindresorhus/p-timeout) - Timeout a promise after a specified amount of time
- [More…](https://github.com/sindresorhus/promise-fun)
