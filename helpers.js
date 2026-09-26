import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const fixture = Symbol('fixture');
export const fixtureError = new Error('fixture');

// Scratch scripts for the subprocess tests. Written outside the repository, because a test that gets
// killed mid-run never reaches its cleanup, and a leftover file in the working tree gets committed.
export const temporaryScript = async (name, body) => {
	// The worker id keeps two concurrent `ava` runs from clobbering each other's script, and has to
	// go before the extension or Node stops reading the file as a module.
	const file = path.join(os.tmpdir(), `${path.parse(name).name}.${process.pid}${path.extname(name)}`);
	await fs.writeFile(file, `import pRetry from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'index.js')).href)};\n${body}`);
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

	t.teardown(() => {
		globalThis.setTimeout = originalSetTimeout;
	});

	return delays;
};
