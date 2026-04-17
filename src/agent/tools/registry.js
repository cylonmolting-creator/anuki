'use strict';

/**
 * Tool Registry — OpenAI function-calling format tool definitions.
 *
 * These definitions are sent with chat completion requests so LLMs
 * know which tools they can invoke. The format follows the OpenAI
 * function calling spec (also supported by DeepSeek, Groq, Together AI,
 * and Ollama's native /api/chat endpoint).
 *
 * Tool list mirrors the capabilities Claude Code CLI provides natively:
 *   Read, Write, Edit, Bash, Grep, Glob, ListDir
 */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the filesystem. Returns the file content as text. Supports optional line offset and limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or workspace-relative path to the file to read'
          },
          offset: {
            type: 'integer',
            description: 'Line number to start reading from (1-based). Optional.'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to read. Optional, defaults to 2000.'
          }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or workspace-relative path to the file to write'
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file'
          }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Edit a file by replacing an exact string match with new text. The old_string must appear exactly once in the file (unless replace_all is true).',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or workspace-relative path to the file to edit'
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace'
          },
          new_string: {
            type: 'string',
            description: 'The replacement string'
          },
          replace_all: {
            type: 'boolean',
            description: 'If true, replace all occurrences. Default: false.'
          }
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a shell command and return its stdout, stderr, and exit code. Use for running scripts, installing packages, git operations, etc. Commands run in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          },
          timeout: {
            type: 'integer',
            description: 'Timeout in milliseconds. Default: 120000 (2 minutes). Max: 600000 (10 minutes).'
          }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents using a regular expression pattern. Returns matching file paths, or matching lines with context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for'
          },
          path: {
            type: 'string',
            description: 'Directory or file to search in. Defaults to workspace root.'
          },
          include: {
            type: 'string',
            description: 'Glob pattern to filter files, e.g. "*.js" or "*.{ts,tsx}"'
          },
          context: {
            type: 'integer',
            description: 'Number of context lines to show around each match. Default: 0.'
          }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern. Returns a list of matching file paths relative to the search directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match, e.g. "**/*.js", "src/**/*.ts", "*.md"'
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to workspace root.'
          }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ListDir',
      description: 'List files and directories in a given path. Returns name, type (file/directory), and size for each entry.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to list. Defaults to workspace root.'
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  }
];

/**
 * Get tool definitions in OpenAI function-calling format.
 * @returns {Array} Array of tool definition objects
 */
function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

/**
 * Get tool definitions in Ollama native format.
 * Ollama uses the same format as OpenAI for tool definitions.
 * @returns {Array} Array of tool definition objects
 */
function getToolDefinitionsForOllama() {
  return TOOL_DEFINITIONS;
}

/**
 * Get a single tool definition by name.
 * @param {string} name - Tool name
 * @returns {object|null} Tool definition or null
 */
function getToolByName(name) {
  return TOOL_DEFINITIONS.find(t => t.function.name === name) || null;
}

/**
 * Get list of available tool names.
 * @returns {string[]}
 */
function getToolNames() {
  return TOOL_DEFINITIONS.map(t => t.function.name);
}

module.exports = {
  getToolDefinitions,
  getToolDefinitionsForOllama,
  getToolByName,
  getToolNames,
  TOOL_DEFINITIONS
};
