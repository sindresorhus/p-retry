import {expectType} from 'tsd';
import pRetry, {makeRetriable, AbortError, type RetryContext} from './index.js';

expectType<Promise<number>>(pRetry(async count => {
	expectType<number>(count);
	return 1;
}));
expectType<Promise<void>>(pRetry(() => {}, { // eslint-disable-line @typescript-eslint/no-empty-function
	onFailedAttempt(context) {
		expectType<RetryContext>(context);
		expectType<number>(context.attemptNumber);
		expectType<number>(context.retriesLeft);
		expectType<number>(context.retriesConsumed);
	},
}));
expectType<Promise<string>>(pRetry(() => 'foo', {
	retries: 5,
}));

expectType<Promise<string>>(pRetry(async () => 'value', {
	async shouldConsumeRetry(context) {
		expectType<RetryContext>(context);
		expectType<Error>(context.error);
		return true;
	},
	minTimeout: 0,
}));

const abortError = new AbortError('foo');
new AbortError(new Error('foo')); // eslint-disable-line no-new

expectType<AbortError>(abortError);

// AbortError
expectType<'AbortError'>(abortError.name);
expectType<Error>(abortError.originalError);
expectType<string>(abortError.message);
expectType<AbortError>(new AbortError('foo'));

// Options that the runtime accepts.
pRetry(() => 'foo', {
	retries: Number.POSITIVE_INFINITY,
	factor: 1.5,
	minTimeout: 0,
	maxTimeout: 1000,
	randomize: true,
	maxRetryTime: 5000,
	unref: true,
	signal: new AbortController().signal,
});

pRetry(() => 'foo', {
	shouldRetry: () => false,
});

pRetry(() => 'foo', {
	async shouldRetry(context) {
		expectType<RetryContext>(context);
		expectType<number>(context.retryDelay);
		return true;
	},
});

// @ts-expect-error - The callback has to be a function.
pRetry(() => 'foo', {onFailedAttempt: 'nope'});

// @ts-expect-error - The option does not exist.
pRetry(() => 'foo', {forever: true});

// makeRetriable
const retried = makeRetriable(async (a: string, b: number) => `${a}${b}`, {retries: 1});
expectType<Promise<string>>(retried('foo', 1));
// @ts-expect-error - The second argument has to be a number.
retried('foo', 'bar');

// @ts-expect-error - `input` is required.
pRetry();
