/**
 * PREVENTION GUARD — Agent Overwrite Protection
 *
 * Root Cause (2026-03-31): Test iterations wrote to production workspace
 * - TOOLS.md: 3159 bytes -> 37 bytes (98% shrink)
 * - first_prompt.txt: 182 lines -> 25 lines (86% shrink)
 * - Cross-file sync cascade corrupted IDENTITY.md and first_prompt.txt
 *
 * Prevention:
 * 1. Content shrink guard — more than 50% shrink = REJECT
 * 2. Workspace protection flag — critical workspaces are protected
 * 3. Sync impact guard — first_prompt.txt line loss above 30% = ROLLBACK
 */

class PreventionGuard {
  /**
   * Guard 1: Content shrink check
   * More than 50% shrink -> REJECT
   * Purpose: Prevent dramatic data loss proactively
   */
  static validateContentShrink(filename, existingContent, newContent) {
    const existingLen = existingContent?.length || 0;
    const newLen = newContent?.length || 0;

    // New file — allowed
    if (existingLen === 0) {
      return { allowed: true, reason: 'new_file' };
    }

    const shrinkBytes = existingLen - newLen;
    const shrinkPercent = (shrinkBytes / existingLen) * 100;

    // Critical files: more than 50% shrink = REJECT
    const criticalFiles = ['first_prompt.txt', 'TOOLS.md', 'IDENTITY.md'];
    if (criticalFiles.includes(filename) && shrinkPercent > 50) {
      return {
        allowed: false,
        reason: 'dangerous_shrink',
        details: {
          filename,
          existingLen,
          newLen,
          shrinkPercent: shrinkPercent.toFixed(1),
          threshold: 50,
          message: `${filename} cannot shrink more than 50% (current: ${shrinkPercent.toFixed(1)}%)`
        }
      };
    }

    return { allowed: true, reason: 'within_threshold' };
  }

  /**
   * Guard 2: Workspace protection check
   * Writing to protected workspaces -> requires extra auth
   */
  static validateWorkspaceProtection(workspaceConfig, isAuthorized) {
    if (workspaceConfig?.protected === true && !isAuthorized) {
      return {
        allowed: false,
        reason: 'workspace_protected',
        details: {
          workspace: workspaceConfig.id,
          protected: true,
          requiresAuth: true,
          authorized: isAuthorized,
          message: `Workspace ${workspaceConfig.id} is protected. Only Anuki can modify.`
        }
      };
    }

    return { allowed: true, reason: 'not_protected_or_authorized' };
  }

  /**
   * Guard 3: Cross-file sync impact check
   * first_prompt.txt line loss above 30% -> warning + ROLLBACK
   * Purpose: Detect sync cascade before it propagates
   */
  static validateSyncImpact(oldContent, newContentAfterSync) {
    if (!oldContent || !newContentAfterSync) {
      return { safe: true, reason: 'no_content' };
    }

    const oldLines = oldContent.split('\n').filter(l => l.trim()).length;
    const newLines = newContentAfterSync.split('\n').filter(l => l.trim()).length;
    const lineLoss = oldLines > 0 ? ((oldLines - newLines) / oldLines) * 100 : 0;

    if (lineLoss > 30) {
      return {
        safe: false,
        reason: 'excessive_sync_impact',
        details: {
          oldLines,
          newLines,
          lineLoss: lineLoss.toFixed(1),
          threshold: 30,
          message: `Sync would cause ${lineLoss.toFixed(1)}% line loss (threshold: 30%)`
        }
      };
    }

    return { safe: true, reason: 'impact_acceptable' };
  }

  /**
   * Helper: Create .original snapshot for protected workspaces
   * Take snapshot on first production deploy, so restore is always possible
   */
  static createOriginalSnapshot(filePath, content) {
    const originalPath = filePath + '.original';
    const fs = require('fs');

    // Skip if .original already exists (first deployment)
    if (!fs.existsSync(originalPath)) {
      try {
        fs.writeFileSync(originalPath, content, 'utf8');
        return { created: true, path: originalPath };
      } catch (e) {
        return { created: false, error: e.message };
      }
    }

    return { created: false, reason: 'already_exists' };
  }
}

module.exports = PreventionGuard;
