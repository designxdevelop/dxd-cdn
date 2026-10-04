#!/usr/bin/env node
//
// Mint a scoped app token for the Objects API, or hash one you already have.
//
//   node scripts/mint-app-token.mjs --app heard --prefixes heard/ --ops put,get
//   node scripts/mint-app-token.mjs --app heard --prefixes heard/ --hash <existing-token>
//
// Prints the plaintext token (hand it to the app) and the APP_TOKENS entry
// (which holds only its SHA-256). The token itself is never stored here.

import { createHash, randomBytes } from 'node:crypto';

const VALID_OPS = ['put', 'get', 'list', 'delete'];

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (!flag.startsWith('--')) continue;
		const name = flag.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith('--')) {
			args[name] = true;
			continue;
		}
		args[name] = next;
		index++;
	}
	return args;
}

function fail(message) {
	console.error(`${message}\n`);
	console.error('Usage: node scripts/mint-app-token.mjs --app <name> --prefixes <a/,b/> [--ops put,get,list,delete] [--hash <token>]');
	process.exit(2);
}

const args = parseArgs(process.argv.slice(2));

const app = typeof args.app === 'string' ? args.app : null;
if (!app) fail('--app is required.');

const prefixes =
	typeof args.prefixes === 'string'
		? args.prefixes
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean)
		: [];
if (!prefixes.length) fail('--prefixes is required, e.g. --prefixes heard/');

const ops =
	typeof args.ops === 'string'
		? args.ops
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean)
		: ['put', 'get'];

const unknownOps = ops.filter((op) => !VALID_OPS.includes(op));
if (unknownOps.length) fail(`Unknown ops: ${unknownOps.join(', ')}. Valid ops are ${VALID_OPS.join(', ')}.`);

const token = typeof args.hash === 'string' ? args.hash : `dxd_${app}_${randomBytes(24).toString('base64url')}`;
const digest = createHash('sha256').update(token).digest('hex');

console.log(`app        ${app}`);
console.log(`prefixes   ${prefixes.join(', ')}`);
console.log(`ops        ${ops.join(', ')}`);
console.log();
if (typeof args.hash === 'string') {
	console.log('Hashed the token you supplied; it is not reprinted.');
} else {
	console.log('Token (store in the consuming app, never in this repo):');
	console.log(`  ${token}`);
}
console.log();
console.log('APP_TOKENS entry:');
console.log(JSON.stringify({ [digest]: { app, prefixes, ops } }, null, 2));
console.log();
console.log('Merge that entry into the existing APP_TOKENS object, then:');
console.log('  wrangler secret put APP_TOKENS          # production');
console.log('  # or add the one-line JSON to .dev.vars for local dev');
