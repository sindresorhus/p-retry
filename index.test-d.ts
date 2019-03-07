import {expectType} from 'tsd-check';
import pRetry, {AbortError, FailedAttemptError} from '.';

expectType<Promise<number>>(
	pRetry(count => {
		expectType<number>(count);
		return Promise.resolve(1);
	})
);
expectType<Promise<void>>(
	pRetry(() => {}, {
		onFailedAttempt: error => {
			expectType<FailedAttemptError>(error);
			expectType<number>(error.attemptNumber);
			expectType<number>(error.retriesLeft);
		}
	})
);
expectType<Promise<string>>(
	pRetry(() => 'foo', {
		retries: 5
	})
);
