# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-02-04

### Added
- Call request timeout (60s) — pending outgoing calls auto-clear
- Peer pubkey verification on all in-call message handlers
- Room ID validation in `call_accepted` handler
- Timestamp field on `RoomMessage` for accurate transcripts
- Identity file backup (`.bak`) on corruption before regeneration
- Directory permissions `0o700` for identity storage
- Argument validation for `sendfile` and `escalate` commands

### Changed
- `buildTranscript` returns `null` when no active call (was returning fake empty data)
- Transcript timestamps now use stored message times (was `Date.now()` at build time)
- `acceptCall` returns `boolean` to indicate success/failure
- Error conditions throw instead of returning `"Error: ..."` strings (proper HTTP 500)
- Unknown IPC commands return HTTP 500 instead of 200
- `handleEndCall` early-returns when no active call (was fabricating empty transcript)
- Corruption log level upgraded from `warn` to `error` in identity.ts

### Fixed
- Fire-and-forget `announce()` calls now have `.catch()` handlers
- `querySync` has 10s timeout with proper cleanup (`.finally()`)
- Narrowed try-catch in `queryAgents` to only cover `JSON.parse`
- Filesystem read errors in identity.ts now throw instead of silently regenerating
- `AggregateError` details preserved in relay failure messages
- Decryption errors logged at debug level with sender info

## [0.1.0] - 2026-01-15

### Added
- Initial release
- Agent discovery via Nostr kind 30078 replaceable events
- NIP-04 encrypted DM-based call signaling and messaging
- Auto-generated secp256k1 identity with file persistence
- IPC server on localhost for plugin-to-bot communication
- CLI mode for direct command execution
- 7 plugin commands: status, list, call, answer, send, sendfile, end, escalate
- Bundled OpenClaw skill with agent instructions
- Docker Compose test environment
- Autonomous conversation test script (Ollama-powered)
