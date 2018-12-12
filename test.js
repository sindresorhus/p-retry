import test from 'ava';
import delay from 'delay';
import m from '.';

const fixture = Symbol('fixture');
const fixtureErr = new Error('fixture');

test('retries', async t => {
	let i = 0;

	const ret = await m(async attemptNumber => {
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

	await m(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? Promise.reject(new m.AbortError(fixtureErr)) : Promise.reject(fixtureErr);
	}).catch(error => {
		t.is(error, fixtureErr);
	});

	t.is(i, 3);
});

test('no retry on TypeError', async t => {
	t.plan(2);

	const tErr = new TypeError('fixture');

	let i = 0;

	await m(async attemptNumber => {
		await delay(40);
		i++;
		return attemptNumber === 3 ? fixture : Promise.reject(tErr);
	}).catch(error => {
		t.is(error, tErr);
	});

	t.is(i, 1);
});

test('AbortError - string', t => {
	const err = new m.AbortError('fixture').originalError;
	t.is(err.constructor.name, 'Error');
	t.is(err.message, 'fixture');
});

test('AbortError - error', t => {
	const err = new m.AbortError(new Error('fixture')).originalError;
	t.is(err.constructor.name, 'Error');
	t.is(err.message, 'fixture');
});

test('onFailedAttempt is called expected number of times', async t => {
	t.plan(8);

	const r = 5;
	let i = 0;
	let j = 0;

	await m(
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

	await m(
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
