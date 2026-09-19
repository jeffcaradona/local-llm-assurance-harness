import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { HarnessError } from '../errors.js';

function escapesRoot(relPath) {
  return (
    isAbsolute(relPath) ||
    relPath === '..' ||
    relPath.startsWith('../') ||
    relPath.startsWith('..\\')
  );
}

export function createFilesystemCollector({
  rootPath,
  runner,
  limits,
  redactor,
}) {
  let canonicalRootPromise;
  const getCanonicalRoot = () =>
    (canonicalRootPromise ??= realpath(resolve(rootPath)));

  async function assertPathContained(absolutePath) {
    const rootReal = await getCanonicalRoot();
    let resolved;
    try {
      resolved = await realpath(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HarnessError(
          'E_FILE_NOT_FOUND',
          'Requested file does not exist.',
          { absolutePath }
        );
      }
      throw error;
    }
    const rel = relative(rootReal, resolved);
    if (escapesRoot(rel)) {
      throw new HarnessError(
        'E_PATH_OUT_OF_ROOT',
        'Path escapes approved root.',
        { absolutePath }
      );
    }
    return { rootReal };
  }

  async function readBoundedText(absolutePath, maxBytes, rootReal) {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink()) {
      throw new HarnessError(
        'E_SYMLINK_BLOCKED',
        'Symlink paths are not collected.',
        { absolutePath }
      );
    }

    const file = await open(absolutePath, 'r');
    try {
      const handleStat = await file.stat();
      const postResolvedPath = await realpath(absolutePath);
      const postRel = relative(rootReal, postResolvedPath);
      if (escapesRoot(postRel)) {
        throw new HarnessError(
          'E_PATH_OUT_OF_ROOT',
          'Path escaped approved root during read.',
          { absolutePath }
        );
      }
      const currentPathStat = await lstat(postResolvedPath);
      if (
        handleStat.dev !== currentPathStat.dev ||
        handleStat.ino !== currentPathStat.ino
      ) {
        throw new HarnessError(
          'E_PATH_RACE_DETECTED',
          'File changed during path validation/read boundary.',
          { absolutePath }
        );
      }

      const retain = Math.min(handleStat.size, maxBytes);
      const buffer = Buffer.alloc(retain);
      const { bytesRead } = await file.read(buffer, 0, retain, 0);
      const body = buffer.subarray(0, bytesRead);
      if (body.includes(0)) {
        throw new HarnessError(
          'E_BINARY_FILE_REJECTED',
          'Binary file content is not supported.',
          { absolutePath }
        );
      }
      return {
        content: body.toString('utf8'),
        retainedBytes: bytesRead,
        originalBytes: handleStat.size,
        truncated: handleStat.size > bytesRead,
      };
    } finally {
      await file.close();
    }
  }

  async function runFd({ signal, limit }) {
    const rootReal = await getCanonicalRoot();
    const result = await runner.run(
      'fd',
      [
        '--type',
        'f',
        '--hidden',
        '--color',
        'never',
        '--exclude',
        '.git',
        '--exclude',
        'node_modules',
        '.',
      ],
      {
        cwd: rootReal,
        signal,
        timeoutMs: limits.subprocessTimeoutMs,
        stdoutMaxBytes: limits.subprocessStdoutBytes,
        stderrMaxBytes: limits.subprocessStderrBytes,
        env: {},
      }
    );
    if (result.exitCode !== 0) {
      throw new HarnessError('E_FIND_FAILED', 'File discovery failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    const files = await Promise.all(
      result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map(async (item) => {
          const abs = await realpath(resolve(rootReal, item));
          return relative(rootReal, abs).replaceAll('\\', '/');
        })
    );
    return files.sort().slice(0, limit ?? limits.maxFiles);
  }

  async function searchText({ pattern, signal, maxMatches }) {
    const rootReal = await getCanonicalRoot();
    const matchLimit = maxMatches ?? limits.maxSearchMatches;
    const result = await runner.run(
      'rg',
      [
        '--json',
        '--fixed-strings',
        '--hidden',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules/**',
        '--max-count',
        String(matchLimit),
        '--max-filesize',
        String(limits.maxFileBytes),
        '--color',
        'never',
        '--',
        pattern,
        rootReal,
      ],
      {
        cwd: rootReal,
        signal,
        timeoutMs: limits.subprocessTimeoutMs,
        stdoutMaxBytes: limits.subprocessStdoutBytes,
        stderrMaxBytes: limits.subprocessStderrBytes,
        env: {},
      }
    );

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new HarnessError('E_SEARCH_FAILED', 'Text search failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    const matches = [];
    const lines = result.stdout.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        if (result.stdoutTruncated && index === lines.length - 1) break;
        throw new HarnessError(
          'E_SEARCH_OUTPUT_INVALID',
          'Search output was malformed.',
          { line }
        );
      }
      if (item.type !== 'match') continue;
      const relPath = relative(rootReal, item.data.path.text);
      matches.push({
        relativePath: relPath,
        lineStart: item.data.line_number,
        lineEnd: item.data.line_number,
        content: redactor.redact(item.data.lines.text),
        retainedBytes: Buffer.byteLength(item.data.lines.text),
        originalBytes: Buffer.byteLength(item.data.lines.text),
        truncated: false,
        redaction: redactor.describe(),
      });
      if (matches.length >= matchLimit) break;
    }
    return matches.sort((a, b) =>
      `${a.relativePath}:${a.lineStart}`.localeCompare(
        `${b.relativePath}:${b.lineStart}`
      )
    );
  }

  async function readTextFile({ path, signal, maxBytes }) {
    if (signal?.aborted) {
      throw new HarnessError('E_ABORTED', 'Read cancelled before start.');
    }
    const rootReal = await getCanonicalRoot();
    const absolutePath = resolve(rootReal, path);
    const containment = await assertPathContained(absolutePath);
    const result = await readBoundedText(
      absolutePath,
      maxBytes ?? limits.maxFileBytes,
      containment.rootReal
    );
    const redacted = redactor.redact(result.content);
    return {
      relativePath: path,
      lineStart: 1,
      lineEnd: redacted.split(/\r?\n/).length,
      content: redacted,
      retainedBytes: Buffer.byteLength(redacted),
      originalBytes: result.originalBytes,
      truncated: result.truncated,
      redaction: redactor.describe(),
    };
  }

  return {
    findFiles: runFd,
    readTextFile,
    searchText,
  };
}
