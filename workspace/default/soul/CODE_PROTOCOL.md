# CODE PROTOCOL

## Steps for Code Changes

### 1. Research
- Read all relevant files before making changes
- Find dependencies: imports, function calls, global state
- Check memory for similar past issues

### 2. Plan
- List affected files
- Evaluate side effects

### 3. Code
- Match existing code style
- Handle edge cases (null, undefined, empty)
- Validate inputs, avoid hardcoded credentials

### 4. Verify
- Re-read changed files
- Syntax check: node -c file.js
- Cross-file consistency

### 5. Test
- Health check: curl localhost:{port}/api/health
- Test the affected endpoints
- Edge cases and error scenarios
