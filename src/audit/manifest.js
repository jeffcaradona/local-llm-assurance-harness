import { mkdir, realpath, writeFile, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { HarnessError } from '../errors.js';
import { throwIfAborted } from '../lifecycle/cancellation.js';

const defaultFilesystem = { mkdir, realpath, writeFile, link, rm };

async function resolveExistingAncestor(pathText, filesystem, signal) {
  let current = pathText;
  // Bound recursion through path roots.
  for (let i = 0; i < 100; i += 1) {
    try {
      throwIfAborted(signal);
      const ancestorReal = await filesystem.realpath(current);
      throwIfAborted(signal);
      return { ancestorInput: current, ancestorReal };
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  throw new HarnessError(
    'E_OUTPUT_PATH_INVALID',
    'Unable to resolve output ancestor path.'
  );
}

export async function persistRunArtifacts({
  outputDir,
  reviewedRoot,
  runId,
  manifest,
  replayBundle,
  signal,
  filesystem = defaultFilesystem,
}) {
  throwIfAborted(signal);
  const rootResolved = await filesystem.realpath(resolve(reviewedRoot));
  throwIfAborted(signal);
  const outResolved = resolve(outputDir);
  const { ancestorInput, ancestorReal } = await resolveExistingAncestor(
    outResolved,
    filesystem,
    signal
  );
  const outCanonical = resolve(
    ancestorReal,
    relative(ancestorInput, outResolved)
  );
  const rel = relative(rootResolved, outCanonical);
  if (
    rel === '' ||
    (!isAbsolute(rel) && !rel.startsWith('..') && rel !== '.')
  ) {
    throw new HarnessError(
      'E_OUTPUT_INSIDE_REPO',
      'Output directory must be outside reviewed root.',
      {
        outputDir: outCanonical,
        reviewedRoot: rootResolved,
      }
    );
  }

  throwIfAborted(signal);
  await filesystem.mkdir(outCanonical, { recursive: true });
  throwIfAborted(signal);

  const manifestPath = resolve(outCanonical, `${runId}.manifest.json`);
  const replayPath = replayBundle
    ? resolve(outCanonical, `${runId}.replay.json`)
    : undefined;
  const staging = resolve(outCanonical, `.run-${randomUUID()}.staging`);
  const stagedManifest = resolve(staging, 'manifest.json');
  const stagedReplay = resolve(staging, 'replay.json');
  const published = [];
  let stagingCreated = false;
  try {
    await filesystem.mkdir(staging);
    stagingCreated = true;
    throwIfAborted(signal);
    const options = { encoding: 'utf8', flag: 'wx', signal };
    await filesystem.writeFile(
      stagedManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      options
    );
    throwIfAborted(signal);
    if (replayPath) {
      await filesystem.writeFile(
        stagedReplay,
        `${JSON.stringify(replayBundle, null, 2)}\n`,
        options
      );
      throwIfAborted(signal);
      await filesystem.link(stagedReplay, replayPath);
      published.push(replayPath);
      throwIfAborted(signal);
    }
    // A manifest is the success marker; publish it only after all other output.
    // Exclusive links avoid overwriting or cleaning up another run's files.
    await filesystem.link(stagedManifest, manifestPath);
    published.push(manifestPath);
    throwIfAborted(signal);
    await filesystem.rm(staging, { recursive: true, force: true });
    stagingCreated = false;
    throwIfAborted(signal);
    return { manifestPath, replayPath };
  } catch (error) {
    // In-flight non-cancellable IO may finish after the caller has returned.
    // This continuation retains ownership and removes only this run's files.
    await Promise.allSettled([
      ...published.map((path) => filesystem.rm(path, { force: true })),
      ...(stagingCreated
        ? [filesystem.rm(staging, { recursive: true, force: true })]
        : []),
    ]);
    throw error;
  }
}
