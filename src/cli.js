import { resolve } from 'node:path';
import { createHarness } from './harness.js';
import { HarnessError } from './errors.js';

function parseArgs(argv) {
  const [command = '--help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    if (options[key] === undefined) options[key] = value;
    else if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  }
  return { command, options };
}

function helpText() {
  return `local-llm-assurance-harness\n\nUsage:\n  npm start -- --help\n  npm start -- review --root . --file src/server.js --request "Review asynchronous lifecycle and error handling."\n  npm start -- review --root . --search "Promise.all" --request "Review concurrency bounds." --format json\n  npm start -- replay --bundle /absolute/path/to/run.replay.json --format terminal\n\nCommands:\n  review    Run deterministic repository review pipeline\n  replay    Render and verify from sanitized replay bundle\n`;
}

function toList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export async function runCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const { command, options } = parseArgs(argv);

  if (command === '--help' || command === 'help') {
    stdout.write(`${helpText()}\n`);
    return 0;
  }

  if (command === 'replay') {
    if (!options.bundle) throw new HarnessError('E_REPLAY_BUNDLE_REQUIRED', 'Replay requires --bundle.');
    const harness = createHarness({ env, rootPath: process.cwd() });
    const report = await harness.replay({ bundlePath: resolve(String(options.bundle)), format: options.format === 'json' ? 'json' : 'terminal' });
    stdout.write(`${report}\n`);
    return 0;
  }

  if (command !== 'review') {
    throw new HarnessError('E_COMMAND_UNKNOWN', 'Unknown command.');
  }

  const rootPath = resolve(String(options.root ?? '.'));
  const request = options.request ? String(options.request) : '';

  const harness = createHarness({ env, rootPath, outputDir: options['output-dir'] ? resolve(String(options['output-dir'])) : undefined });

  const rootController = new AbortController();
  const shutdown = async () => {
    rootController.abort();
    await harness.shutdown();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    const result = await harness.review({
      rootPath,
      request,
      selectedFiles: toList(options.file).map(String),
      searches: toList(options.search).map(String),
      instructionFiles: toList(options.instructions).map((x) => resolve(String(x))),
      includeReplay: options.replay === true,
      format: options.format === 'json' ? 'json' : 'terminal',
      signal: rootController.signal
    });
    stdout.write(`${result.reportText}\n`);
    stdout.write(`Manifest: ${result.manifestPath}\n`);
    if (result.replayPath) stdout.write(`Replay bundle: ${result.replayPath}\n`);
    return 0;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

export function formatError(error) {
  if (error instanceof HarnessError) {
    return JSON.stringify({ code: error.code, message: error.message, details: error.details }, null, 2);
  }
  return JSON.stringify({ code: 'E_INTERNAL', message: error?.message ?? String(error) }, null, 2);
}
