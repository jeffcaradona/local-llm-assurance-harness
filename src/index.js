#!/usr/bin/env node
import { formatError, runCli } from './cli.js';

runCli()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
