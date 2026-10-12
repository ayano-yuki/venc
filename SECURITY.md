# Security model and hardening status

venc is an unaudited prototype for encrypted storage and explicit, process-local unlocking.
It is not an isolation boundary against software that already controls the user account or editor.
The two passwords are two required secrets, not two independent authentication factors.

## Implemented protections

- Independent Argon2id derivations and HKDF domains; authenticated VMK/file-key wrapping and content encryption.
- Encrypted file names, directory structure, timestamps, and file-key metadata.
- Authentication before returning file plaintext; bounded ciphertext lengths before decryption.
- Fixed validated KDF costs, 16 MiB file/metadata limits, bounded IPC frames, queued writes, and pending requests.
- Fail-closed IPC schema and payload validation; unknown replies, malformed messages, and timeouts disconnect access.
- In-flight filesystem results are rejected after mount revocation; stale sessions cannot return data through the provider.
- Exclusive cooperative process locks, immutable object writes, synchronized atomic metadata/header replacement, and session invalidation after commit errors.
- Both old passwords required for password changes; VMK and file objects remain unchanged.
- Initial protocol handshake before requesting passwords; trusted workspace and machine-scoped executable setting; restored locations checked against the authenticated vault ID.
- Explicit dirty-document/notebook save checks, cancellation-safe normal locking, and disconnect notification.
- Normal idle child disposal closes stdin so Rust can drop its session; a termination fallback handles stuck children. Forced termination cannot guarantee Rust destructors run.
- No persisted passwords, keys, decrypted temporary files, shell invocation, network listener, or plaintext IPC logging.

These are implemented and locally tested controls, not an independent security certification.

## Residual risks and required follow-up

| Concern | Current boundary / follow-up |
| --- | --- |
| Standard editor backups | Plaintext crash backup reproduced with Hot Exit off in normal VS Code 1.95.3. Require separately validated isolated storage or a future custom editor with encrypted backup control. |
| Other editor/OS copies | Extensions, language servers, clipboard, Save As, swap, hibernation, and dumps can retain plaintext. Key zeroization does not erase those copies. |
| JavaScript memory | Strings and runtime copies cannot be reliably zeroized. References are released promptly; clearing owned byte buffers is best effort. |
| Rollback | Restoring a valid older vault is not detected. External trusted state would be needed. |
| Password revocation | Older wrapped-VMK snapshots still work with their passwords. Header rewrapping is not retroactive revocation. |
| Recovery | Losing either password prevents decryption; there is no recovery key. |
| Hostile local filesystem | Symlink checks reject known links but do not eliminate path-replacement races, lock-file replacement, or noncooperative mutation. Harden with directory-handle-based storage in a future change. |
| Metadata side channels | Object counts, ciphertext sizes, and host filesystem times remain observable. |
| Incomplete initialization | Failed initialization can leave a new incomplete directory; existing directories are never overwritten. |
| Crash/power loss | Commit ordering and directory sync are tested at the API level; exhaustive power-loss and platform filesystem testing is pending. Unix permission/sync behavior is not a Windows guarantee. |
| Storage growth | Replaced/deleted encrypted objects remain to avoid unsafe deletion before commit. Crash-safe garbage collection is pending. |
| Large files | Files are bounded at 16 MiB. Authenticated chunk encryption and streaming are pending. |
| Compatibility | Prototype v1 metadata has evolved; current readers accept early metadata, old binaries may reject updates. Stable versioning and migration are pending. |
| Audit | Independent review, fuzzing, systematic fault injection, and broader platform validation remain necessary. |

Keep independent encrypted backups. Never include passwords, keys, decrypted documents, or an unredacted vault in public bug reports.

## Validation

Rust tests cover password requirements, authentication domains, tampering/truncation, lock lifecycle, concurrent unlock rejection, encrypted metadata, filesystem contracts, password changes, and forced commit failures.
Extension tests cover real-core filesystem/lifecycle behavior, hidden notebook saves, cancelled/failed lock operations, revoked in-flight reads, malformed envelopes/payloads, queue limits, and timeout handling.
Actual VS Code integration tests cover text edits and encrypted saves; a separate normal-profile test confirms the backup risk.
Local verification is Linux x64. Cross-platform CI configuration does not substitute for a completed independent audit or power-loss test.

Reference: [VS Code 1.95.3 backup tracker](https://github.com/microsoft/vscode/blob/1.95.3/src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts).
