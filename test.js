import test from 'ava';
import delay from 'delay';
import pRetry from '.';

const fixture = Symbol('fixture');
const fixtureErr = new Error('fixture');

test('retries', async t => {
	let i = 0;

	const ret = await pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? fixture : Promise.reject(fixtureErr);
	});

	t.is(ret, fixture);
	t.is(i, 3);
});

test('aborts', async t => {
	t.plan(2);

	let i = 0;

	await pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? Promise.reject(new pRetry.AbortError(fixtureErr)) : Promise.reject(fixtureErr);
	}).catch(error => {
		t.is(error, fixtureErr);
	});

	t.is(i, 3);
});

test('no retry on TypeError', async t => {
	t.plan(2);

	const tErr = new TypeError('fixture');

	let i = 0;

	await pRetry(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? fixture : Promise.reject(tErr);
	}).catch(error => {
		t.is(error, tErr);
	});

	t.is(i, 1);
});

test('AbortError - string', t => {
	const err = new pRetry.AbortError('fixture').originalError;
	t.is(err.constructor.name, 'Error');
	t.is(err.message, 'fixture');
});

test('AbortError - error', t => {
	const err = new pRetry.AbortError(new Error('fixture')).originalError;
	t.is(err.constructor.name, 'Error');
	t.is(err.message, 'fixture');
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
			return attemptNumber === 3 ? fixture : Promise.reject(fixtureErr);
		},
		{
			onFailedAttempt: err => {
				t.is(err, fixtureErr);
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
		},
	);

	t.is(i, 3);
	t.is(j, 2);
});

test('onFailedAttempt is called before last rejection', async t => {
	t.plan(15);

	const r = 3;
	let i = 0;
	let j = 0;

	await pRetry(
		async () => {
			await delay(40);
			i++;
			return Promise.reject(fixtureErr);
		},
		{
			onFailedAttempt: err => {
				t.is(err, fixtureErr);
				t.is(err.attemptNumber, ++j);

				switch (i) {
					case 1:
						t.is(err.retriesLeft, r);
						break;
					case 2:
						t.is(err.retriesLeft, 2);
						break;
					case 3:
						t.is(err.retriesLeft, 1);
						break;
					case 4:
						t.is(err.retriesLeft, 0);
						break;
					default:
						t.fail('onFailedAttempt was called more than 4 times');
						break;
				}
			},
			retries: r
		},
	).catch(error => {
		t.is(error, fixtureErr);
		t.is(i, 4);
		t.is(j, 4);
	});
});

test('onFailedAttempt receives context when defined', async t => {
	await pRetry(
		async () => {
			await delay(40);
			return Promise.reject(fixtureErr);
		},
		{
			onFailedAttempt: (err, con) => {
				t.is(err, fixtureErr);
				t.is(con.simulated, 'context');
				t.is(con.fake, true);
			},
			context: {
				simulated: 'context',
				fake: true
			},
			retries: 2
		}
	).catch(error => {
		t.is(error, fixtureErr);
	});
});
