# p-retry [![Build Status](https://travis-ci.org/sindresorhus/p-retry.svg?branch=master)](https://travis-ci.org/sindresorhus/p-retry)

> Retry a promise-returning or async function

It does exponential backoff and supports custom retry strategies for failed operations.


## Install

```
$ npm install p-retry
```


## Usage

```js
const pRetry = require('p-retry');
const fetch = require('node-fetch');

const run = () => fetch('https://sindresorhus.com/unicorn')
	.then(response => {
		// Abort retrying if the resource doesn't exist
		if (response.status === 404) {
			throw new pRetry.AbortError(response.statusText);
		}

		return response.blob();
	});

pRetry(run, {retries: 5}).then(result => {});
```

With the `onFailedAttempt` option:

```js
const run = () => fetch('https://sindresorhus.com/unicorn')
	.then(response => {
		if (response.status !== 200) {
			throw new Error(response.statusText);
		}

		return response.json();
	});

pRetry(run, {
	onFailedAttempt: error => {
		console.log(`Attempt ${error.attemptNumber} failed. There are ${error.attemptsLeft} attempts left.`),
		// 1st request => Attempt 1 failed. There are 4 retries left.
		// 2nd request => Attempt 2 failed. There are 3 retries left.
		// ...
	},
	retries: 5
}).then(result => {});
```


## API

### pRetry(input, [options])

Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

It doesn't retry on `TypeError` as that's a user error.

#### input

Type: `Function`

Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.

#### options

Type: `Object`

Options are passed to the [`retry`](https://github.com/tim-kos/node-retry#retryoperationoptions) module.

##### onFailedAttempt(err)

Type: `Function`

Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `attemptsLeft` which indicate the current attempt number and the number of attempts left, respectively.

### pRetry.AbortError(message|error)

Abort retrying and reject the promise.

### message

Type: `string`

Error message.

### error

Type: `Error`

Custom error.


## Related

- [p-timeout](https://github.com/sindresorhus/p-timeout) - Timeout a promise after a specified amount of time
- [More…](https://github.com/sindresorhus/promise-fun)


## License

MIT © [Sindre Sorhus](https://sindresorhus.com)
