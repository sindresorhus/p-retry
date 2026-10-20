import {expectTypeOf, expectError} from 'nz';
import pRetry, {makeRetriable, AbortError, type RetryContext} from './index.js';

expectTypeOf(pRetry(async count => {
	expectTypeOf(count).toBe<number>();
	return 1;
})).toBe<Promise<number>>();
expectTypeOf(pRetry(() => {}, { // eslint-disable-line @typescript-eslint/no-empty-function
	onFailedAttempt(context) {
		expectTypeOf(context).toBe<RetryContext>();
		expectTypeOf(context.attemptNumber).toBe<number>();
		expectTypeOf(context.retriesLeft).toBe<number>();
		expectTypeOf(context.retriesConsumed).toBe<number>();
	},
})).toBe<Promise<void>>();
expectTypeOf(pRetry(() => 'foo', {
	retries: 5,
})).toBe<Promise<string>>();

expectTypeOf(pRetry(async () => 'value', {
	async shouldConsumeRetry(context) {
		expectTypeOf(context).toBe<RetryContext>();
		expectTypeOf(context.error).toBe<Error>();
		return true;
	},
	minTimeout: 0,
})).toBe<Promise<string>>();

const abortError = new AbortError('foo');
new AbortError(new Error('foo')); // eslint-disable-line no-new

expectTypeOf(abortError).toBe<AbortError>();

// No argument is legal at runtime, and the suite relies on it.
expectTypeOf(new AbortError()).toBe<AbortError>();

// AbortError
expectTypeOf(abortError.name).toBe<'AbortError'>();
expectTypeOf(abortError.originalError).toBe<Error>();
expectTypeOf(abortError.message).toBe<string>();
expectTypeOf(new AbortError('foo')).toBe<AbortError>();

// Options that the runtime accepts.
expectTypeOf(pRetry(() => 'foo', {
	retries: Infinity,
	factor: 1.5,
	minTimeout: 0,
	maxTimeout: 1000,
	randomize: true,
	maxRetryTime: 5000,
	unref: true,
	signal: new AbortController().signal,
})).toBe<Promise<string>>();

// The runtime treats `undefined` as "not provided" for every option, and the suite relies on it for the callbacks, so an options object built from optional configuration has to type-check. Only visible with `exactOptionalPropertyTypes`.
expectTypeOf(pRetry(() => 'foo', {
	retries: undefined,
	factor: undefined,
	minTimeout: undefined,
	maxTimeout: undefined,
	maxRetryTime: undefined,
	randomize: undefined,
	unref: undefined,
	onFailedAttempt: undefined,
	shouldRetry: undefined,
	shouldConsumeRetry: undefined,
	signal: undefined,
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	shouldRetry: () => false,
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	async shouldRetry(context) {
		expectTypeOf(context).toBe<RetryContext>();
		expectTypeOf(context.retryDelay).toBe<number>();
		return true;
	},
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	shouldConsumeRetry() {
		return undefined;
	},
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	async shouldConsumeRetry() {
		return undefined;
	},
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	shouldConsumeRetry(context) {
		expectTypeOf(context).toBe<RetryContext>();
	},
})).toBe<Promise<string>>();

expectTypeOf(pRetry(() => 'foo', {
	async shouldConsumeRetry(context) {
		expectTypeOf(context).toBe<RetryContext>();
	},
})).toBe<Promise<string>>();

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
expectTypeOf(retried('foo', 1)).toBe<Promise<string>>();
expectError(retried('foo', 'bar'));

// Explicit type arguments in the order of the earlier releases still work, because `This` comes last and has a default.
const retriedExplicit = makeRetriable<[string], number>(async (a: string) => a.length);
expectTypeOf(retriedExplicit('foo')).toBe<Promise<number>>();

// The wrapper calls the function with the receiver it was called with, so a function that declares `this` must keep it. Without it, the type would allow a call that crashes at runtime.
function usesThis(this: {value: number}, extra: string) {
	return `${this.value}${extra}`;
}

const retriedWithThis = makeRetriable(usesThis, {retries: 1});
expectTypeOf(retriedWithThis.call({value: 1}, 'foo')).toBe<Promise<string>>();
expectError(retriedWithThis('foo'));
