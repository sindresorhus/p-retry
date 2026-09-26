import assert from 'node:assert/strict';
import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const fixture = Symbol('fixture');
export const fixtureError = new Error('fixture');

// `assert.rejects` has no identity form, so this stands in for what AVA's `{is: error}` did. The
// comparison runs as an assertion of its own, so a mismatch names the error that actually came out.
export const rejectsWith = expected => error => {
	assert.equal(error, expected);
	return true;
};

// Scratch scripts for the subprocess tests. Written outside the repository, because a test that gets
// killed mid-run never reaches its cleanup, and a leftover file in the working tree gets committed.
export const temporaryScript = async (name, body) => {
	// The worker id keeps two concurrent test runs from clobbering each other's script, and has to
	// go before the extension or Node stops reading the file as a module.
	const {name: base, ext} = path.parse(name);
	const file = path.join(os.tmpdir(), `${base}.${process.pid}${ext}`);
	const module = pathToFileURL(path.join(process.cwd(), 'index.js')).href;
	await fs.writeFile(file, `import pRetry from ${JSON.stringify(module)};\n${body}`);
	return file;
};

// Records the delays that were scheduled, so a test can assert on what was waited for instead of on
// how long the machine took. The real delay is kept, so the operation still runs for real.
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
