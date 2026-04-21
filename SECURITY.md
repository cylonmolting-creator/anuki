# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Anuki, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. **Email**: Send details to the maintainers via GitHub's private vulnerability reporting (Settings > Security > Report a vulnerability)
3. **Include**: Steps to reproduce, affected versions, and potential impact

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Architecture

Anuki implements multiple layers of security:

- **API Authentication**: Bearer token (HMAC-SHA256, timing-safe comparison)
- **Credential Encryption**: AES-256-GCM with random IV per operation
- **Origin Validation**: Strict allowlist (no wildcard, no port stripping)
- **SSRF Protection**: Private IP blocking on webhook forwarding
- **XSS Prevention**: `escapeHtml()` applied before `formatContent()`
- **Input Sanitization**: Path traversal guards, workspace ID validation, filename sanitization
- **Shell Injection Prevention**: `execFileSync`/`spawnSync` with argument arrays (no string interpolation)
- **Credential Leak Detection**: Regex-based scanning of agent responses
- **Security Headers**: Helmet middleware (CSP, X-Frame-Options, etc.)
- **Rate Limiting**: Per-connection WebSocket (200/min), per-IP webhook (30/min)

## Sensitive Files

The following files/directories contain secrets and must never be committed:

- `.security/` — Master encryption key, API token, encrypted credentials
- `.env` — Environment variables (tokens, keys)

Both are listed in `.gitignore` and `.dockerignore`.
