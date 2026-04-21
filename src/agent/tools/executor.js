'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { tryParseJSON } = require('../../utils/helpers');

/**
 * Tool Executor — Secure tool execution for non-CLI LLM providers.
 *
 * Provides the same capabilities that Claude Code CLI has natively:
 *   Read, Write, Edit, Bash, Grep, Glob, ListDir
 *
 * Security layers:
 *   1. Path validation — all file paths must resolve within workspace boundary
 *   2. Command blocklist — dangerous shell patterns are rejected
 *   3. Resource limits — timeout, output size caps
 */

// --- Security: Command Blocklist ---

const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\//,  // rm -rf /
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//,  // rm -fr /
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,                       // fork bomb
  /dd\s+if=\/dev\//,                                                    // disk overwrite
  /mkfs/,                                                               // filesystem format
  />\s*\/dev\/[sh]d/,                                                   // direct disk write
  /chmod\s+(-R\s+)?777\s+\//,                                         // permission nuke on root
  /curl\s+.*\|\s*(ba)?sh/,                                            // pipe curl to shell
  /wget\s+.*\|\s*(ba)?sh/,                                            // pipe wget to shell
  /\bsudo\b/,                                                          // sudo commands
  /\breboot\b/,                                                        // system reboot
  /\bshutdown\b/,                                                      // system shutdown
  /\blaunchctl\s+(unload|bootout|kickstart)/,                         // launchd manipulation
  /\bkillall\b/,                                                       // killall
  /\bpkill\s+(node|claude)\b/,                                        // kill node/claude
];

/**
 * Check if a command is safe to execute.
 * @param {string} command
 * @returns {{ safe: boolean, reason?: string }}
 */
function validateCommand(command) {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Blocked: command matches dangerous pattern (${pattern.source.substring(0, 40)}...)` };
    }
  }
  return { safe: true };
}

// --- Security: Path Validation ---

/**
 * Resolve and validate a file path against workspace boundary.
 * @param {string} filePath - The path to validate (absolute or relative)
 * @param {string} workspaceDir - The workspace root directory
 * @returns {{ valid: boolean, resolved: string, error?: string }}
 */
function validatePath(filePath, workspaceDir) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, resolved: '', error: 'File path is required and must be a string' };
  }

  // Resolve relative paths against workspace
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceDir, filePath);

  // Must be within workspace
  const normalizedWorkspace = path.resolve(workspaceDir);
  if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
    return {
      valid: false,
      resolved,
      error: `Path "${filePath}" resolves outside workspace boundary (${normalizedWorkspace})`
    };
  }

  return { valid: true, resolved };
}

// --- Tool Implementations ---

/**
 * Read a file.
 */
function toolRead(args, workspaceDir) {
  const { file_path, offset, limit } = args;
  const pathCheck = validatePath(file_path, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error };

  try {
    if (!fs.existsSync(pathCheck.resolved)) {
      return { success: false, error: `File not found: ${file_path}` };
    }

    const stat = fs.statSync(pathCheck.resolved);
    if (stat.isDirectory()) {
      return { success: false, error: `Path is a directory, not a file: ${file_path}` };
    }
    if (stat.size > 10 * 1024 * 1024) { // 10MB limit
      return { success: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 10MB` };
    }

    const content = fs.readFileSync(pathCheck.resolved, 'utf-8');
    const lines = content.split('\n');

    const startLine = Math.max(0, (offset || 1) - 1);
    const maxLines = limit || 2000;
    const slice = lines.slice(startLine, startLine + maxLines);

    // Format with line numbers
    const numbered = slice.map((line, i) => `${startLine + i + 1}\t${line}`).join('\n');
    const truncated = slice.length < lines.length - startLine;

    let output = numbered;
    if (truncated) {
      output += `\n\n[Showing lines ${startLine + 1}-${startLine + slice.length} of ${lines.length} total]`;
    }

    return { success: true, output };
  } catch (err) {
    return { success: false, error: `Read error: ${err.message}` };
  }
}

/**
 * Write a file.
 */
function toolWrite(args, workspaceDir) {
  const { file_path, content } = args;
  const pathCheck = validatePath(file_path, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error };

  if (content === undefined || content === null) {
    return { success: false, error: 'Content is required' };
  }

  try {
    // Create parent directories
    const dir = path.dirname(pathCheck.resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(pathCheck.resolved, content, 'utf-8');
    const stat = fs.statSync(pathCheck.resolved);
    return { success: true, output: `File written: ${file_path} (${stat.size} bytes)` };
  } catch (err) {
    return { success: false, error: `Write error: ${err.message}` };
  }
}

/**
 * Edit a file by string replacement.
 */
function toolEdit(args, workspaceDir) {
  const { file_path, old_string, new_string, replace_all } = args;
  const pathCheck = validatePath(file_path, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error };

  if (!old_string) return { success: false, error: 'old_string is required' };
  if (new_string === undefined) return { success: false, error: 'new_string is required' };

  try {
    if (!fs.existsSync(pathCheck.resolved)) {
      return { success: false, error: `File not found: ${file_path}` };
    }

    let content = fs.readFileSync(pathCheck.resolved, 'utf-8');

    if (replace_all) {
      if (!content.includes(old_string)) {
        return { success: false, error: `String not found in file: "${old_string.substring(0, 80)}..."` };
      }
      const count = content.split(old_string).length - 1;
      content = content.split(old_string).join(new_string);
      fs.writeFileSync(pathCheck.resolved, content, 'utf-8');
      return { success: true, output: `Replaced ${count} occurrence(s) in ${file_path}` };
    }

    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return { success: false, error: `String not found in file: "${old_string.substring(0, 80)}..."` };
    }
    if (occurrences > 1) {
      return { success: false, error: `String found ${occurrences} times — must be unique (or use replace_all). Provide more context to make it unique.` };
    }

    content = content.replace(old_string, new_string);
    fs.writeFileSync(pathCheck.resolved, content, 'utf-8');
    return { success: true, output: `Edit applied to ${file_path}` };
  } catch (err) {
    return { success: false, error: `Edit error: ${err.message}` };
  }
}

/**
 * Execute a shell command.
 */
function toolBash(args, workspaceDir) {
  const { command, timeout } = args;

  if (!command || typeof command !== 'string') {
    return { success: false, error: 'Command is required and must be a string' };
  }

  const cmdCheck = validateCommand(command);
  if (!cmdCheck.safe) {
    return { success: false, error: cmdCheck.reason };
  }

  const effectiveTimeout = Math.min(timeout || 120000, 600000); // Max 10 minutes
  const maxBuffer = 5 * 1024 * 1024; // 5MB output limit

  try {
    const result = execSync(command, {
      cwd: workspaceDir,
      timeout: effectiveTimeout,
      maxBuffer,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME }
    });

    const output = (result || '').substring(0, 1024 * 1024); // Truncate to 1MB for model
    return { success: true, output: output || '(no output)' };
  } catch (err) {
    // execSync throws on non-zero exit code
    const stdout = (err.stdout || '').substring(0, 512 * 1024);
    const stderr = (err.stderr || '').substring(0, 512 * 1024);
    const exitCode = err.status || 1;

    if (err.killed) {
      return { success: false, error: `Command timed out after ${effectiveTimeout}ms` };
    }

    // Non-zero exit but output exists — return it with exit code
    return {
      success: false,
      output: stdout || undefined,
      error: `Exit code ${exitCode}${stderr ? ': ' + stderr.substring(0, 2000) : ''}`
    };
  }
}

/**
 * Search file contents with grep/rg.
 */
function toolGrep(args, workspaceDir) {
  const { pattern, path: searchPath, include, context } = args;

  if (!pattern) return { success: false, error: 'Pattern is required' };

  const searchDir = searchPath
    ? validatePath(searchPath, workspaceDir)
    : { valid: true, resolved: workspaceDir };

  if (!searchDir.valid) return { success: false, error: searchDir.error };

  try {
    // Use spawnSync with argument arrays to prevent shell injection
    let result;
    const contextNum = context ? Math.min(context, 10) : 0;

    // Try rg first, fall back to grep
    const whichRg = spawnSync('which', ['rg'], { stdio: 'pipe' });
    if (whichRg.status === 0) {
      const args = ['-n'];
      if (contextNum) args.push('-C', String(contextNum));
      if (include) args.push('--glob', include);
      args.push(pattern, searchDir.resolved);
      const rg = spawnSync('rg', args, {
        cwd: workspaceDir,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8'
      });
      result = (rg.stdout || '').split('\n').slice(0, 200).join('\n');
      if (rg.status > 1) return { success: false, error: `Grep error: ${(rg.stderr || '').substring(0, 500)}` };
    } else {
      const args = ['-rn'];
      if (contextNum) args.push(`-C${contextNum}`);
      if (include) args.push(`--include=${include}`);
      args.push(pattern, searchDir.resolved);
      const grepResult = spawnSync('grep', args, {
        cwd: workspaceDir,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8'
      });
      result = (grepResult.stdout || '').split('\n').slice(0, 200).join('\n');
      if (grepResult.status > 1) return { success: false, error: `Grep error: ${(grepResult.stderr || '').substring(0, 500)}` };
    }

    return { success: true, output: result.trim() || '(no matches found)' };
  } catch (err) {
    return { success: false, error: `Grep error: ${(err.message || '').substring(0, 500)}` };
  }
}

/**
 * Find files matching a glob pattern.
 */
function toolGlob(args, workspaceDir) {
  const { pattern, path: searchPath } = args;

  if (!pattern) return { success: false, error: 'Pattern is required' };

  const searchDir = searchPath
    ? validatePath(searchPath, workspaceDir)
    : { valid: true, resolved: workspaceDir };

  if (!searchDir.valid) return { success: false, error: searchDir.error };

  try {
    // Use spawnSync with argument array to prevent shell injection
    const findResult = spawnSync('find', [
      searchDir.resolved,
      '-name', pattern,
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.git/*'
    ], {
      cwd: workspaceDir,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8'
    });

    const result = (findResult.stdout || '').split('\n').slice(0, 500).join('\n');

    if (!result.trim()) {
      return { success: true, output: '(no files matched)' };
    }

    // Make paths relative to workspace
    const files = result.trim().split('\n').map(f => {
      return path.relative(workspaceDir, f) || f;
    });

    return { success: true, output: files.join('\n') };
  } catch (err) {
    return { success: false, error: `Glob error: ${(err.message || '').substring(0, 500)}` };
  }
}

/**
 * List directory contents.
 */
function toolListDir(args, workspaceDir) {
  const dirPath = args.path || '.';

  const pathCheck = validatePath(dirPath, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error };

  try {
    if (!fs.existsSync(pathCheck.resolved)) {
      return { success: false, error: `Directory not found: ${dirPath}` };
    }

    const stat = fs.statSync(pathCheck.resolved);
    if (!stat.isDirectory()) {
      return { success: false, error: `Path is a file, not a directory: ${dirPath}` };
    }

    const entries = fs.readdirSync(pathCheck.resolved, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
      .slice(0, 500) // Cap at 500 entries
      .map(entry => {
        const type = entry.isDirectory() ? 'dir' : 'file';
        try {
          const entryPath = path.join(pathCheck.resolved, entry.name);
          const entryStat = fs.statSync(entryPath);
          const size = entry.isDirectory() ? '' : ` (${formatSize(entryStat.size)})`;
          return `${type}\t${entry.name}${size}`;
        } catch {
          return `${type}\t${entry.name}`;
        }
      });

    return { success: true, output: lines.join('\n') || '(empty directory)' };
  } catch (err) {
    return { success: false, error: `ListDir error: ${err.message}` };
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- Main Executor ---

const TOOL_MAP = {
  Read: toolRead,
  Write: toolWrite,
  Edit: toolEdit,
  Bash: toolBash,
  Grep: toolGrep,
  Glob: toolGlob,
  ListDir: toolListDir
};

/**
 * Execute a tool by name with given arguments.
 *
 * @param {string} name - Tool name (Read, Write, Edit, Bash, Grep, Glob, ListDir)
 * @param {object} args - Tool arguments (parsed JSON from LLM)
 * @param {{ workspaceDir: string, logger?: object }} context - Execution context
 * @returns {{ success: boolean, output?: string, error?: string }}
 */
function executeTool(name, args, context) {
  const { workspaceDir, logger } = context;

  if (!workspaceDir) {
    return { success: false, error: 'workspaceDir is required in context' };
  }

  const toolFn = TOOL_MAP[name];
  if (!toolFn) {
    return { success: false, error: `Unknown tool: "${name}". Available: ${Object.keys(TOOL_MAP).join(', ')}` };
  }

  // Ensure args is an object
  const safeArgs = (typeof args === 'string') ? tryParseJSON(args) : (args || {});

  if (logger) {
    logger.debug('ToolExecutor', `Executing ${name}`, { args: summarizeArgs(safeArgs) });
  }

  try {
    const result = toolFn(safeArgs, workspaceDir);

    if (logger) {
      const status = result.success ? 'OK' : 'FAIL';
      logger.debug('ToolExecutor', `${name} ${status}`, {
        outputLen: (result.output || result.error || '').length
      });
    }

    return result;
  } catch (err) {
    if (logger) {
      logger.error('ToolExecutor', `${name} threw: ${err.message}`);
    }
    return { success: false, error: `Tool execution failed: ${err.message}` };
  }
}

/**
 * Summarize tool args for logging (truncate long values).
 */
function summarizeArgs(args) {
  const summary = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 100) {
      summary[k] = v.substring(0, 100) + '...';
    } else {
      summary[k] = v;
    }
  }
  return summary;
}

module.exports = {
  executeTool,
  validatePath,
  validateCommand,
  TOOL_MAP
};
