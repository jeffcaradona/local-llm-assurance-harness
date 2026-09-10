import { resolveRuntimeConfig, validateRuntimeConfig } from './config.js';
import { createRedactor } from './redaction.js';
import { createSubprocessRunner } from './subprocess/runner.js';
import { createFilesystemCollector } from './filesystem/collector.js';
import { createCapabilityRegistry } from './capabilities/registry.js';
import { createOpenAICompatibleProvider } from './model/openaiCompatibleProvider.js';
import { createAdmissionController } from './admission/controller.js';
import { createLifecycleManager } from './lifecycle/manager.js';
import { createReviewOrchestrator } from './orchestrator/reviewOrchestrator.js';
import { createReplayOrchestrator } from './orchestrator/replay.js';

/**
 * Composition root for runtime-owned services and boundaries.
 */
export function createHarness({ env = process.env, rootPath, outputDir, provider } = {}) {
  const config = validateRuntimeConfig(resolveRuntimeConfig(env));
  if (outputDir) config.review.outputDir = outputDir;

  const runner = createSubprocessRunner();
  const redactor = createRedactor({
    secrets: [env.HARNESS_REDACT_SECRET_1, env.HARNESS_REDACT_SECRET_2].filter(Boolean)
  });

  const collector = createFilesystemCollector({
    rootPath,
    runner,
    limits: config.limits,
    redactor
  });
  const capabilities = createCapabilityRegistry({ rootPath, collector });

  const reviewProvider = provider ?? createOpenAICompatibleProvider(config.model);
  const admission = createAdmissionController({
    maxActive: config.limits.activeRequests,
    maxQueued: config.limits.queuedRequests
  });
  const lifecycle = createLifecycleManager({
    admission,
    shutdownGraceMs: config.limits.shutdownGraceMs,
    shutdownDeadlineMs: config.limits.shutdownDeadlineMs
  });

  const reviewOrchestrator = createReviewOrchestrator({
    config,
    capabilities,
    provider: reviewProvider,
    admission,
    lifecycle
  });

  return {
    config,
    review: reviewOrchestrator.review,
    replay: createReplayOrchestrator().replay,
    shutdown: lifecycle.shutdown
  };
}
