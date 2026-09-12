import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { HarnessError } from '../errors.js';

async function resolveExistingAncestor(pathText) {
  let current = pathText;
  // Bound recursion through path roots.
  for (let i = 0; i < 100; i += 1) {
    try {
      return { ancestorInput: current, ancestorReal: await realpath(current) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  throw new HarnessError('E_OUTPUT_PATH_INVALID', 'Unable to resolve output ancestor path.');
}

export async function persistRunArtifacts({ outputDir, reviewedRoot, runId, manifest, replayBundle }) {
  const rootResolved = await realpath(resolve(reviewedRoot));
  const outResolved = resolve(outputDir);
  const { ancestorInput, ancestorReal } = await resolveExistingAncestor(outResolved);
  const outCanonical = resolve(ancestorReal, relative(ancestorInput, outResolved));
  const rel = relative(rootResolved, outCanonical);
  if (rel === '' || (!rel.startsWith('..') && rel !== '.')) {
    throw new HarnessError('E_OUTPUT_INSIDE_REPO', 'Output directory must be outside reviewed root.', {
      outputDir: outCanonical,
      reviewedRoot: rootResolved
    });
  }

  await mkdir(outCanonical, { recursive: true });

  const manifestPath = resolve(outCanonical, `${runId}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  let replayPath;
  if (replayBundle) {
    replayPath = resolve(outCanonical, `${runId}.replay.json`);
    await writeFile(replayPath, `${JSON.stringify(replayBundle, null, 2)}\n`, 'utf8');
  }

  return { manifestPath, replayPath };
}
