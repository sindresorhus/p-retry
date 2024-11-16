import test from 'ava';
import delay from 'delay';
import pRetry, {AbortError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('retries', async t => {
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
	});

	t.is(returnValue, fixture);
	t.is(index, 3);
});

test('aborts', async t => {
	t.plan(2);

	let index = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? Promise.reject(new AbortError(fixtureError)) : Promise.reject(fixtureError);
	}), {is: fixtureError});

	t.is(index, 3);
});

test('no retry on TypeError', async t => {
	t.plan(2);

	const typeErrorFixture = new TypeError('type-error-fixture');

	let index = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	}), {is: typeErrorFixture});

	t.is(index, 1);
});

test('retry on TypeError - failed to fetch', async t => {
	const typeErrorFixture = new TypeError('Failed to fetch');
	let index = 0;

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	});

	t.is(returnValue, fixture);
	t.is(index, 3);
});

test('AbortError - string', t => {
	const error = new AbortError('fixture').originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('AbortError - error', t => {
	const error = new AbortError(new Error('fixture')).originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('onFailedAttempt is called expected number of times', async t => {
	t.plan(8);

	const retries = 5;
	let index = 0;
	let attemptNumber = 0;

	await pRetry(
		async attemptNumber => {
			await delay(40);
			index++;
			return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
		},
		{
			onFailedAttempt(error) {
				t.is(error, fixtureError);
				t.is(error.attemptNumber, ++attemptNumber);

				switch (index) {
					case 1: {
						t.is(error.retriesLeft, retries);
						break;
					}

					case 2: {
						t.is(error.retriesLeft, 4);
						break;
					}

					case 3: {
						t.is(error.retriesLeft, 3);
						break;
					}

					case 4: {
						t.is(error.retriesLeft, 2);
						break;
					}

					default: {
						t.fail('onFailedAttempt was called more than 4 times');
						break;
					}
				}
			},
			retries,
		},
	);

	t.is(index, 3);
	t.is(attemptNumber, 2);
});

test('onFailedAttempt is called before last rejection', async t => {
	t.plan(15);

	const r = 3;
	let i = 0;
	let j = 0;

	await t.throwsAsync(pRetry(
		async () => {
			await delay(40);
			i++;
			throw fixtureError;
		},
		{
			onFailedAttempt(error) {
				t.is(error, fixtureError);
				t.is(error.attemptNumber, ++j);

				switch (i) {
					case 1: {
						t.is(error.retriesLeft, r);
						break;
					}

					case 2: {
						t.is(error.retriesLeft, 2);
						break;
					}

					case 3: {
						t.is(error.retriesLeft, 1);
						break;
					}

					case 4: {
						t.is(error.retriesLeft, 0);
						break;
					}

					default: {
						t.fail('onFailedAttempt was called more than 4 times');
						break;
					}
				}
			},
			retries: r,
		},
	), {is: fixtureError});

	t.is(i, 4);
	t.is(j, 4);
});

test('onFailedAttempt can return a promise to add a delay', async t => {
	const waitFor = 1000;
	const start = Date.now();
	let isCalled;

	await pRetry(
		async () => {
			if (isCalled) {
				return fixture;
			}

			isCalled = true;

			throw fixtureError;
		},
		{
			async onFailedAttempt() {
				await delay(waitFor);
			},
		},
	);

	t.true(Date.now() > start + waitFor);
});

test('onFailedAttempt can throw, causing all retries to be aborted', async t => {
	t.plan(1);
	const error = new Error('thrown from onFailedAttempt');

	try {
		await pRetry(async () => {
			throw fixtureError;
		}, {
			onFailedAttempt() {
				throw error;
			},
		});
	} catch (error_) {
		t.is(error_, error);
	}
});

test('onFailedAttempt can be undefined', async t => {
	const error = new Error('thrown from onFailedAttempt');

	await t.throwsAsync(pRetry(() => {
		throw error;
	}, {
		onFailedAttempt: undefined,
		retries: 1,
	}), {
		is: error,
	});
});

test('shouldRetry can be undefined', async t => {
	const error = new Error('thrown from onFailedAttempt');

	await t.throwsAsync(pRetry(() => {
		throw error;
	}, {
		shouldRetry: undefined,
		retries: 1,
	}), {
		is: error,
	});
});

test('throws useful error message when non-error is thrown', async t => {
	await t.throwsAsync(pRetry(() => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}), {
		message: /Non-error/,
	});
});

test('aborts with an AbortSignal', async t => {
	t.plan(2);

	let index = 0;
	const controller = new AbortController();

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		if (attemptNumber === 3) {
			controller.abort();
		}

		throw fixtureError;
	}, {
		signal: controller.signal,
	}), {
		// TODO: Make this only `instanceOf: DOMException` when targeting Node.js 18.
		instanceOf: globalThis.DOMException === undefined ? Error : DOMException,
	});

	t.is(index, 3);
});

test('preserves the abort reason', async t => {
	t.plan(2);

	let index = 0;
	const controller = new AbortController();

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		index++;
		if (attemptNumber === 3) {
			controller.abort(fixtureError);
			return;
		}

		throw fixtureError;
	}, {
		signal: controller.signal,
	}), {
		is: fixtureError,
	});

	t.is(index, 3);
});

test('should retry only when shouldRetry returns true', async t => {
	t.plan(2);

	const shouldRetryError = new Error('should-retry');
	const customError = new Error('custom-error');

	let index = 0;

	await t.throwsAsync(pRetry(async () => {
		await delay(40);
		index++;
		const error = index < 3 ? shouldRetryError : customError;
		throw error;
	}, {
		async shouldRetry(error) {
			return error.message === shouldRetryError.message;
		},
		retries: 10,
	}), {
		is: customError,
	});

	t.is(index, 3);
});

test('can retry functions that throw non-extensible errors', async t => {
	let index = 0;
	const nonExtensibleError = Object.preventExtensions(new Error('non-extensible-error'));

	const returnValue = await pRetry(async attemptNumber => {
		await delay(40);
		index++;
		return attemptNumber === 3 ? fixture : Promise.reject(nonExtensibleError);
	});

	t.is(returnValue, fixture);
	t.is(index, 3);
});
