import {OperationOptions} from 'retry';

export interface FailedAttemptError extends Error {
	readonly attemptNumber: number;
	readonly retriesLeft: number;
}

export interface Options extends OperationOptions {
	/**
	 * Callback invoked on each retry. Receives the error thrown by `input` as the first argument with properties `attemptNumber` and `retriesLeft` which indicate the current attempt number and the number of attempts left, respectively.
	 */
	readonly onFailedAttempt?: (error: FailedAttemptError) => void;
}

/**
 * Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.
 *
 * It doesn't retry on `TypeError` as that's a user error.
 *
 * @param input - Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.
 * @param options - Options are passed to the [`retry`](https://github.com/tim-kos/node-retry#retryoperationoptions) module.
 */
export default function pRetry<T>(
	input: (attemptCount: number) => PromiseLike<T> | T,
	options?: Options
): Promise<T>;

export class AbortError extends Error {
	readonly name: 'AbortError';
	readonly originalError: Error;

	/**
	 * Abort retrying and reject the promise.
	 *
	 * @param message - Error message or custom error.
	 */
	constructor(message: string | Error);
}
