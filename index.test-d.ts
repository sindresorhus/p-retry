import {expectError, expectType} from 'tsd';
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

// No argument is legal at runtime, and the suite relies on it.
expectType<AbortError>(new AbortError());

// AbortError
expectType<'AbortError'>(abortError.name);
expectType<Error>(abortError.originalError);
expectType<string>(abortError.message);
expectType<AbortError>(new AbortError('foo'));

// Options that the runtime accepts.
expectType<Promise<string>>(pRetry(() => 'foo', {
	retries: Infinity,
	factor: 1.5,
	minTimeout: 0,
	maxTimeout: 1000,
	randomize: true,
	maxRetryTime: 5000,
	unref: true,
	signal: new AbortController().signal,
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	shouldRetry: () => false,
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	async shouldRetry(context) {
		expectType<RetryContext>(context);
		expectType<number>(context.retryDelay);
		return true;
	},
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	shouldConsumeRetry() {
		return undefined;
	},
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	async shouldConsumeRetry() {
		return undefined;
	},
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	shouldConsumeRetry(context) {
		expectType<RetryContext>(context);
	},
}));

expectType<Promise<string>>(pRetry(() => 'foo', {
	async shouldConsumeRetry(context) {
		expectType<RetryContext>(context);
	},
}));

// Returning nothing from `shouldRetry` means "never retry", so a forgotten `return` is a type error.
expectError(pRetry(() => 'foo', {
	shouldRetry(context) {
		console.log(context.error);
	},
}));

expectError(pRetry(() => 'foo', {
	async shouldRetry(context) {
		console.log(context.error);
	},
}));

expectError(pRetry(() => 'foo', {shouldRetry: () => 'yes'}));
expectError(pRetry(() => 'foo', {shouldConsumeRetry: async () => 'yes'}));
expectError(pRetry(() => 'foo', {shouldRetry: () => 42}));
expectError(pRetry(() => 'foo', {shouldConsumeRetry: async () => 42}));

expectError(pRetry(() => 'foo', {onFailedAttempt: 'nope'}));
expectError(pRetry(() => 'foo', {forever: true}));
expectError(pRetry());

// `makeRetriable`
const retried = makeRetriable(async (a: string, b: number) => `${a}${b}`, {retries: 1});
expectType<Promise<string>>(retried('foo', 1));
expectError(retried('foo', 'bar'));
