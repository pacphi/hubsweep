#!/usr/bin/env node
import { main } from '../src/cli.mjs';
main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`hubsweep: ${e.stack || e}\n`); process.exitCode = 1; });
