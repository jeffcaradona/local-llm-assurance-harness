import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { HarnessError } from '../errors.js';

function makeEvidenceId(index) {
  return `ev-${String(index + 1).padStart(4, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function escapesRoot(relPath) {
  return relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\');
}

export function createFilesystemCollector({ rootPath, runner, limits, redactor }) {
  const canonicalRootPromise = realpath(resolve(rootPath));

  async function assertPathContained(absolutePath) {
    const rootReal = await canonicalRootPromise;
    const resolved = await realpath(absolutePath);
    const rel = relative(rootReal, resolved);
    if (escapesRoot(rel)) {
      throw new HarnessError('E_PATH_OUT_OF_ROOT', 'Path escapes approved root.', { absolutePath });
    }
  }

  async function readBoundedText(absolutePath, maxBytes) {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new HarnessError('E_SYMLINK_BLOCKED', 'Symlink paths are not collected.', { absolutePath });
    }

    const file = await open(absolutePath, 'r');
    try {
      const retain = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(retain);
      const { bytesRead } = await file.read(buffer, 0, retain, 0);
      const body = buffer.subarray(0, bytesRead);
      if (body.includes(0)) {
        throw new HarnessError('E_BINARY_FILE_REJECTED', 'Binary file content is not supported.', { absolutePath });
      }
      return {
        content: body.toString('utf8'),
        retainedBytes: bytesRead,
        originalBytes: stat.size,
        truncated: stat.size > bytesRead
      };
    } finally {
      await file.close();
    }
  }

  async function runFd({ signal, limit }) {
    const rootReal = await canonicalRootPromise;
    const result = await runner.run('fd', ['--type', 'f', '--hidden', '--color', 'never', '.', rootReal], {
      cwd: rootReal,
      signal,
      timeoutMs: limits.subprocessTimeoutMs,
      stdoutMaxBytes: limits.subprocessStdoutBytes,
      stderrMaxBytes: limits.subprocessStderrBytes,
      env: {}
    });
    if (result.exitCode !== 0) {
      throw new HarnessError('E_FIND_FAILED', 'File discovery failed.', { stderr: result.stderr, exitCode: result.exitCode });
    }
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()
      .slice(0, limit ?? limits.maxFiles);
  }

  async function searchText({ pattern, signal, maxMatches }) {
    const rootReal = await canonicalRootPromise;
    const result = await runner.run('rg', ['--json', '--fixed-strings', '--color', 'never', '--', pattern, rootReal], {
      cwd: rootReal,
      signal,
      timeoutMs: limits.subprocessTimeoutMs,
      stdoutMaxBytes: limits.subprocessStdoutBytes,
      stderrMaxBytes: limits.subprocessStderrBytes,
      env: {}
    });

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new HarnessError('E_SEARCH_FAILED', 'Text search failed.', { stderr: result.stderr, exitCode: result.exitCode });
    }

    const matches = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        throw new HarnessError('E_SEARCH_OUTPUT_INVALID', 'Search output was malformed.', { line });
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
        redaction: redactor.describe()
      });
      if (matches.length >= (maxMatches ?? limits.maxSearchMatches)) break;
    }
    return matches.sort((a, b) => `${a.relativePath}:${a.lineStart}`.localeCompare(`${b.relativePath}:${b.lineStart}`));
  }

  async function readTextFile({ absolutePath, relativePath, signal, maxBytes }) {
    if (signal?.aborted) {
      throw new HarnessError('E_ABORTED', 'Read cancelled before start.');
    }
    await assertPathContained(absolutePath);
    const result = await readBoundedText(absolutePath, maxBytes ?? limits.maxFileBytes);
    const redacted = redactor.redact(result.content);
    return {
      relativePath,
      lineStart: 1,
      lineEnd: redacted.split(/\r?\n/).length,
      content: redacted,
      retainedBytes: Buffer.byteLength(redacted),
      originalBytes: result.originalBytes,
      truncated: result.truncated,
      redaction: redactor.describe()
    };
  }

  async function toEvidenceItems(records, capability) {
    return records.map((record, index) => ({
      id: makeEvidenceId(index),
      capability,
      sourcePath: record.relativePath,
      lineRange: record.lineStart ? [record.lineStart, record.lineEnd] : null,
      content: record.content,
      collectedAt: nowIso(),
      retainedBytes: record.retainedBytes,
      originalBytes: record.originalBytes,
      truncated: record.truncated,
      redaction: record.redaction
    }));
  }

  return {
    findFiles: runFd,
    readTextFile,
    searchText,
    async collect({ selectedFiles, searches, signal }) {
      let totalBytes = 0;
      const evidence = [];

      const files = selectedFiles?.length ? [...new Set(selectedFiles)].sort() : await runFd({ signal, limit: limits.maxFiles });

      for (const pathText of files) {
        if (totalBytes >= limits.maxEvidenceBytes) break;
        const absolute = resolve(await canonicalRootPromise, pathText);
        const item = await readTextFile({ absolutePath: absolute, relativePath: pathText, signal, maxBytes: limits.maxFileBytes });
        const [ev] = await toEvidenceItems([item], 'filesystem.readTextFile');
        ev.id = makeEvidenceId(evidence.length);
        evidence.push(ev);
        totalBytes += ev.retainedBytes;
      }

      for (const pattern of searches ?? []) {
        if (totalBytes >= limits.maxEvidenceBytes) break;
        const hits = await searchText({ pattern, signal, maxMatches: limits.maxSearchMatches });
        const items = await toEvidenceItems(hits, 'filesystem.searchText');
        for (const item of items) {
          item.id = makeEvidenceId(evidence.length);
          if (totalBytes + item.retainedBytes > limits.maxEvidenceBytes) break;
          evidence.push(item);
          totalBytes += item.retainedBytes;
        }
      }

      return evidence;
    }
  };
}
