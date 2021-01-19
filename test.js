import test from 'ava';
import delay from 'delay';
import pRetry from '.';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('retries', async t => {
	let i = 0;

	const ret = await pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
	});

	t.is(ret, fixture);
	t.is(i, 3);
});

test('aborts', async t => {
	t.plan(2);

	let i = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? Promise.reject(new pRetry.AbortError(fixtureError)) : Promise.reject(fixtureError);
	}), {is: fixtureError});

	t.is(i, 3);
});

test('no retry on TypeError', async t => {
	t.plan(2);

	const typeErrorFixture = new TypeError('type-error-fixture');

	let i = 0;

	await t.throwsAsync(pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? fixture : Promise.reject(typeErrorFixture);
	}), {is: typeErrorFixture});

	t.is(i, 1);
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
	const error = new pRetry.AbortError('fixture').originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('AbortError - error', t => {
	const error = new pRetry.AbortError(new Error('fixture')).originalError;
	t.is(error.constructor.name, 'Error');
	t.is(error.message, 'fixture');
});

test('onFailedAttempt is called expected number of times', async t => {
	t.plan(8);

	const r = 5;
	let i = 0;
	let j = 0;

	await pRetry(
		async attemptNumber => {
			await delay(40);
			i++;
			return attemptNumber === 3 ? fixture : Promise.reject(fixtureError);
		},
		{
			onFailedAttempt: err => {
				t.is(err, fixtureError);
				t.is(err.attemptNumber, ++j);

				switch (i) {
					case 1:
						t.is(err.retriesLeft, r);
						break;
					case 2:
						t.is(err.retriesLeft, 4);
						break;
					case 3:
						t.is(err.retriesLeft, 3);
						break;
					case 4:
						t.is(err.retriesLeft, 2);
						break;
					default:
						t.fail('onFailedAttempt was called more than 4 times');
						break;
				}
			},
			retries: r
		}
	);

	t.is(i, 3);
	t.is(j, 2);
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
			return Promise.reject(fixtureError);
		},
		{
			onFailedAttempt: error => {
				t.is(error, fixtureError);
				t.is(error.attemptNumber, ++j);

				switch (i) {
					case 1:
						t.is(error.retriesLeft, r);
						break;
					case 2:
						t.is(error.retriesLeft, 2);
						break;
					case 3:
						t.is(error.retriesLeft, 1);
						break;
					case 4:
						t.is(error.retriesLeft, 0);
						break;
					default:
						t.fail('onFailedAttempt was called more than 4 times');
						break;
				}
			},
			retries: r
		}
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
			onFailedAttempt: async () => {
				await delay(waitFor);
			}
		}
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
			onFailedAttempt: () => {
				throw error;
			}
		});
	} catch (error_) {
		t.is(error_, error);
	}
});

test('throws useful error message when non-error is thrown', async t => {
	await t.throwsAsync(pRetry(() => {
		throw 'foo'; // eslint-disable-line no-throw-literal
	}), /Non-error/);
});
