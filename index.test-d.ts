import {expectType} from 'tsd';
import pRetry, {AbortError, FailedAttemptError} from './index.js';

expectType<Promise<number>>(
	pRetry(async count => {
		expectType<number>(count);
		return Promise.resolve(1);
	}),
);
expectType<Promise<void>>(
	pRetry(() => undefined, {
		onFailedAttempt: error => {
			expectType<FailedAttemptError>(error);
			expectType<number>(error.attemptNumber);
			expectType<number>(error.retriesLeft);
		},
	}),
);
expectType<Promise<string>>(
	pRetry(() => 'foo', {
		retries: 5,
	}),
);

const abortError = new AbortError('foo');
new AbortError(new Error('foo')); // eslint-disable-line no-new

expectType<AbortError>(abortError);
