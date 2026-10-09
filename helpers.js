import assert from 'node:assert/strict';
import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const fixture = Symbol('fixture');
export const fixtureError = new Error('fixture');

// `assert.rejects` has no identity form, so this stands in for what AVA's `{is: error}` did. The comparison runs as an assertion of its own, so a mismatch names the error that actually came out.
export const rejectsWith = expected => error => {
	assert.equal(error, expected);
	return true;
};

// Scratch scripts for the subprocess tests. Written outside the repository, because a test that gets killed mid-run never reaches its cleanup, and a leftover file in the working tree gets committed.
export const temporaryScript = async (name, body) => {
	// The process id keeps two runs from clobbering each other's script, and has to go before the extension or Node stops reading the file as a module.
	const {name: base, ext} = path.parse(name);
	const file = path.join(os.tmpdir(), `${base}.${process.pid}${ext}`);
	// Resolved from this file, so the tests work from any working directory.
	const module = new URL('index.js', import.meta.url).href;
	await fs.writeFile(file, `import pRetry, {AbortError} from ${JSON.stringify(module)};\n${body}`);
	return file;
};

// Removes a scratch script without letting a failure to do so hide the assertion that just failed.
export const removeTemporaryScript = async file => {
	try {
		await fs.unlink(file);
	} catch {}
};

// The three helpers below each patch a process global and restore it from `t.after`, which node:test runs in registration order rather than last-in-first-out. Two of them in one test would restore the real timer and then the first patch, leaving that patch installed for the rest of the file. One per test, and no test does that today.

// Records the delays that were scheduled and makes each wait happen at once, so a test that asserts on a delay does not have to sit through it. The clock is left alone, for the tests that drive `performance.now` themselves, and for the ones that never spend a retry budget.
export const collapseDelays = t => {
	const delays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		delays.push(ms);
		return originalSetTimeout(function_, 0, ...arguments_);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	return delays;
};

// Records the delays that were scheduled, so a test can assert on what was waited for instead of on how long the machine took. The real delay is kept, so the operation still runs for real.
export const captureDelays = t => {
	const delays = [];
	const originalSetTimeout = setTimeout;

	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		delays.push(ms);
		return originalSetTimeout(function_, ms, ...arguments_);
	};

	t.after(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	return delays;
};

// Drives both clocks so a test that has to wait can finish at once and still be charged the time it means to. `performance.now` only moves when a wait is scheduled, so a budget can never be spent by the machine being slow, which is what made several of these tests pass or fail on load alone. A wait is charged when it is scheduled, not when it fires, so a timer that is later cleared is still charged, and the order of `delays` cannot show whether one wait was awaited before the next.
//
// `setTimeout` is patched globally, so the `delay` package is recorded in `delays` too. Several tests read their own callback's wait back out of the array, which only works because of that.
export const withFakeTime = async t => {
	const originalPerformanceNow = performance.now;
	const originalSetTimeout = setTimeout;
	const delays = [];
	let now = 0;

	performance.now = () => now;
	globalThis.setTimeout = (function_, ms, ...arguments_) => {
		delays.push(ms);
		// Guarded because `setTimeout(fn)` with no delay gives `undefined`, which would turn the clock into `NaN` and silently disable every `maxRetryTime` check for the rest of the test.
		if (Number.isFinite(ms)) {
			now += ms; // The wait costs what it says, but happens immediately.
		}

		return originalSetTimeout(function_, 0, ...arguments_);
	};

	t.after(() => {
		performance.now = originalPerformanceNow;
		globalThis.setTimeout = originalSetTimeout;
	});

	// `delays` is every delay p-retry scheduled, in order.
	return {now: () => now, delays};
};
