import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, basename } from 'node:path';
import { HarnessError } from '../errors.js';

export async function persistRunArtifacts({ outputDir, reviewedRoot, runId, manifest, replayBundle }) {
  const rootResolved = await realpath(resolve(reviewedRoot));
  const outResolved = resolve(outputDir);
  const outParentReal = await realpath(resolve(dirname(outResolved)));
  const outCanonical = resolve(outParentReal, basename(outResolved));
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
