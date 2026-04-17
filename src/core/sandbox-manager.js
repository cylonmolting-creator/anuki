/**
 * SandboxManager — Stub for MVP
 *
 * ANUKI MVP doesn't use ephemeral sandboxes yet.
 * This stub provides the interface that executor.js expects.
 * Full implementation will come in a later phase.
 */
class SandboxManager {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Pre-execution sync — no-op in MVP (agents work directly in workspace)
   */
  preExecutionSync(overrideDir, agentName) {
    return { success: true, skipped: true, reason: 'MVP stub — no sandbox' };
  }

  /**
   * Post-execution deploy — no-op in MVP
   */
  postExecutionDeploy(workspaceDir, agentName) {
    return { success: true, skipped: true, deployed: false, reason: 'not-sandbox-persistent', gates: { syntax: 'skipped', critical: 'skipped', soul: 'skipped' } };
  }
}

module.exports = SandboxManager;
