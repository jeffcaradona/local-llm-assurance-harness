import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { HarnessError } from '../errors.js';

export async function persistRunArtifacts({ outputDir, reviewedRoot, runId, manifest, replayBundle }) {
  const rootResolved = resolve(reviewedRoot);
  const outResolved = resolve(outputDir);
  const rel = relative(rootResolved, outResolved);
  if (!rel.startsWith('..')) {
    throw new HarnessError('E_OUTPUT_INSIDE_REPO', 'Output directory must be outside reviewed root.', {
      outputDir: outResolved,
      reviewedRoot: rootResolved
    });
  }

  await mkdir(outResolved, { recursive: true });

  const manifestPath = resolve(outResolved, `${runId}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  let replayPath;
  if (replayBundle) {
    replayPath = resolve(outResolved, `${runId}.replay.json`);
    await writeFile(replayPath, `${JSON.stringify(replayBundle, null, 2)}\n`, 'utf8');
  }

  return { manifestPath, replayPath };
}
