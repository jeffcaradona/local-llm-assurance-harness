import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { HarnessError } from '../errors.js';
import {
  isLikelySensitivePath,
  resolveContainedPath,
  withCollectionMetadata,
} from '../capabilities/registry.js';

function checkAborted(signal) {
  if (signal?.aborted)
    throw new HarnessError('E_ABORTED', 'Collection cancelled.');
}

function boundedLimit(value, maximum) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new HarnessError(
      'E_CAPABILITY_INPUT_INVALID',
      'Invalid collection limit.'
    );
  }
  return Math.min(value ?? maximum, maximum);
}

const SKIPPABLE_CODES = new Set([
  'E_PATH_OUT_OF_ROOT',
  'E_SENSITIVE_PATH_BLOCKED',
  'E_SYMLINK_BLOCKED',
  'E_FILE_NOT_FOUND',
  'E_CAPABILITY_INPUT_INVALID',
]);

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
  const configuredRoot = resolve(rootPath);
  let canonicalRootPromise;
  const getCanonicalRoot = () =>
    (canonicalRootPromise ??= realpath(configuredRoot));

  async function assertPathContained(pathText, signal) {
    checkAborted(signal);
    const rootReal = await getCanonicalRoot();
    let absolutePath;
    try {
      const configuredPath = resolveContainedPath(configuredRoot, pathText);
      absolutePath = resolve(
        rootReal,
        relative(configuredRoot, configuredPath)
      );
    } catch (error) {
      if (
        error.code !== 'E_PATH_OUT_OF_ROOT' ||
        typeof pathText !== 'string' ||
        !isAbsolute(pathText.replaceAll('\\', '/'))
      )
        throw error;
      // Subprocesses run from the canonical root and may emit canonical paths.
      absolutePath = resolveContainedPath(rootReal, pathText);
    }
    const relativePath = relative(rootReal, absolutePath).replaceAll('\\', '/');
    if (
      isLikelySensitivePath(pathText) ||
      isLikelySensitivePath(relativePath)
    ) {
      throw new HarnessError(
        'E_SENSITIVE_PATH_BLOCKED',
        'Sensitive file path blocked by policy.'
      );
    }
    let resolved;
    try {
      resolved = await realpath(absolutePath);
    } catch (error) {
      if (error?.code === 'ELOOP') {
        throw new HarnessError(
          'E_SYMLINK_BLOCKED',
          'Symlink paths are not collected.'
        );
      }
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
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
    if (isLikelySensitivePath(rel)) {
      throw new HarnessError(
        'E_SENSITIVE_PATH_BLOCKED',
        'Sensitive file path blocked by policy.'
      );
    }
    let currentPath = rootReal;
    let pathStat = await lstat(rootReal);
    for (const component of relativePath.split('/').filter(Boolean)) {
      checkAborted(signal);
      currentPath = resolve(currentPath, component);
      pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        throw new HarnessError(
          'E_SYMLINK_BLOCKED',
          'Symlink paths are not collected.'
        );
      }
    }
    checkAborted(signal);
    if (!pathStat.isFile()) {
      throw new HarnessError(
        'E_CAPABILITY_INPUT_INVALID',
        'Only regular files are collected.'
      );
    }
    return { rootReal, absolutePath, relativePath, pathStat };
  }

  async function readBoundedText(containment, maxBytes, signal) {
    const { absolutePath, pathStat } = containment;
    checkAborted(signal);
    const file = await open(
      absolutePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      const handleStat = await file.stat();
      if (!handleStat.isFile()) {
        throw new HarnessError(
          'E_CAPABILITY_INPUT_INVALID',
          'Only regular files are collected.'
        );
      }
      const { pathStat: currentPathStat } = await assertPathContained(
        absolutePath,
        signal
      );
      if (
        handleStat.dev !== currentPathStat.dev ||
        handleStat.ino !== currentPathStat.ino ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino
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
      checkAborted(signal);
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
    checkAborted(signal);
    const fileLimit = boundedLimit(limit, limits.maxFiles);
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
    checkAborted(signal);
    if (result.exitCode !== 0) {
      throw new HarnessError('E_FIND_FAILED', 'File discovery failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    const files = new Set();
    let omittedCount = 0;
    const lines = result.stdout.split(/\r?\n/);
    if (result.stdoutTruncated) lines.pop();
    for (const item of lines.filter(Boolean)) {
      try {
        const { relativePath } = await assertPathContained(item, signal);
        files.add(relativePath);
      } catch (error) {
        if (!SKIPPABLE_CODES.has(error.code)) throw error;
        omittedCount += 1;
      }
    }
    return withCollectionMetadata([...files].sort().slice(0, fileLimit), {
      truncated: result.stdoutTruncated || files.size > fileLimit,
      omittedCount: omittedCount + Math.max(0, files.size - fileLimit),
    });
  }

  async function searchText({ pattern, signal, maxMatches }) {
    checkAborted(signal);
    if (
      typeof pattern !== 'string' ||
      !pattern ||
      pattern.startsWith('-') ||
      pattern.includes('\0')
    ) {
      throw new HarnessError(
        'E_CAPABILITY_INPUT_INVALID',
        'Invalid search pattern.'
      );
    }
    const rootReal = await getCanonicalRoot();
    const matchLimit = boundedLimit(maxMatches, limits.maxSearchMatches);
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
    checkAborted(signal);

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new HarnessError('E_SEARCH_FAILED', 'Text search failed.', {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    const matches = [];
    let omittedCount = 0;
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
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new HarnessError(
          'E_SEARCH_OUTPUT_INVALID',
          'Search output was malformed.'
        );
      }
      if (item.type !== 'match') continue;
      if (
        typeof item.data?.path?.text !== 'string' ||
        typeof item.data?.lines?.text !== 'string' ||
        !Number.isSafeInteger(item.data.line_number) ||
        item.data.line_number < 1
      ) {
        throw new HarnessError(
          'E_SEARCH_OUTPUT_INVALID',
          'Search output was malformed.'
        );
      }
      let relPath;
      try {
        ({ relativePath: relPath } = await assertPathContained(
          item.data.path.text,
          signal
        ));
      } catch (error) {
        if (SKIPPABLE_CODES.has(error.code)) {
          omittedCount += 1;
          continue;
        }
        throw error;
      }
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
    return withCollectionMetadata(
      matches.sort((a, b) =>
        `${a.relativePath}:${a.lineStart}`.localeCompare(
          `${b.relativePath}:${b.lineStart}`
        )
      ),
      {
        truncated: result.stdoutTruncated || matches.length >= matchLimit,
        omittedCount,
      }
    );
  }

  async function readTextFile({ path, signal, maxBytes }) {
    checkAborted(signal);
    const byteLimit = boundedLimit(maxBytes, limits.maxFileBytes);
    const containment = await assertPathContained(path, signal);
    const result = await readBoundedText(containment, byteLimit, signal);
    const redacted = redactor.redact(result.content);
    return {
      relativePath: containment.relativePath,
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
