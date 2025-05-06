import {expectType} from 'tsd';
import pRetry, {AbortError, type RetryContext} from './index.js';

expectType<Promise<number>>(
	pRetry(async count => {
		expectType<number>(count);
		return 1;
	}),
);
expectType<Promise<void>>(
	pRetry(() => {}, { // eslint-disable-line @typescript-eslint/no-empty-function
		onFailedAttempt(context) {
			expectType<RetryContext>(context);
			expectType<number>(context.attemptNumber);
			expectType<number>(context.retriesLeft);
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
