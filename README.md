# venc — Vault ENCrypt

[English](README.md) | [日本語](README.ja.md)

venc is a two-password encrypted vault with a Rust core, a CLI, and a VS Code extension.
Open a vault as a `venc://` virtual workspace, edit files in VS Code, and encrypt changes when saving.
Both passwords are needed to recover the vault master key. This is **not two-factor authentication**.

**Security boundary:** the provider writes ciphertext, but the standard VS Code editor can write plaintext crash backups even with Hot Exit disabled. This has been reproduced in VS Code 1.95.3. Do not assume that an ordinary VS Code profile keeps plaintext off disk. See [the security model](SECURITY.md) before storing sensitive data.

## VS Code extension

Install a VSIX using **Extensions: Install from VSIX...**, then run **venc: Create Vault** or **venc: Open Vault**.
The extension asks for both passwords and adds a named virtual workspace folder to Explorer.
Use normal file/folder creation, editing, saving, renaming, and deletion.

The status bar shows open and locked vault counts. Commands also include **Open Another Vault**, **Lock Vault**, **Lock All Vaults**, **Change Vault Passwords**, and **Forget Vault Location**.
A cancelled lock or failed save leaves the vault open. Removing its workspace folder releases the core session.

See the [extension guide](vscode-extension/README.md) for settings, multiple vaults, remote hosts, packaging, and editor limitations.
Passwords and keys are never stored in extension state. Remembered vault IDs and physical paths can be removed with **Forget Vault Location**.

## Build and test

Requirements: a Rust toolchain, a C linker (GCC or Clang on Linux), Node.js 22.12+ and npm.
Desktop VS Code 1.95+ is supported; browser-only VS Code cannot run the Rust child process.

```sh
cargo build --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cd vscode-extension
npm ci --ignore-scripts
npm test
```

Tests use the actual Rust binary at `target/debug/venc` (`venc.exe` on Windows).
Set `VENC_TEST_CORE` to an absolute executable path to test a different build.
Editor tests require a display or Xvfb and Electron's system libraries:

```sh
npm run test:integration
npm run test:backups
```

The first exercises actual VS Code document editing and saving. The second uses a disposable normal profile to reproduce the plaintext crash-backup limitation. Test profiles and data are removed afterwards.
CI is configured for Rust and provider tests on Linux, macOS, and Windows, and editor tests on Linux. These CI jobs have not been executed remotely as part of this change; local validation was on Linux x64.

## Package

From `vscode-extension/`:

```sh
npm run package
```

The packaging script builds the Rust core for the current host, stages the executable with executable permissions, and produces a platform-specific VSIX.
It avoids bundling a stale core left in `bin/`. Dependencies, tests, and source code are excluded from the VSIX.
Build each OS/CPU package on its matching host. A dynamically linked binary may require matching host libraries; a Nix-built executable may include Nix store paths. Validate the package on its intended platform.
The locally supplied Linux x64 artifact uses a statically linked core. Other packaged platforms remain unverified locally.

## Development CLI

```sh
./target/debug/venc init ./my-vault
./target/debug/venc unlock ./my-vault
```

`init` requires a new directory and confirms both passwords. `unlock` starts a process-local session.
Passwords are entered without terminal echo, never supplied as command arguments or environment variables.
Enter one JSON array per line:

```json
["add", "./document.txt", "notes/document.txt"]
["list"]
["extract", "notes/document.txt", "./exported.txt"]
["passwd"]
["remove", "notes/document.txt"]
["lock"]
```

`add` creates or replaces a vault file. **`extract` explicitly writes plaintext** and refuses existing output paths.
`passwd` requires both current passwords and wraps the same master key under the new pair; it does not re-encrypt file data.
`lock` or EOF ends the session. `add`, `extract`, and `lock` are session commands, not separate authenticated processes.

The extension uses `venc serve` over private stdin/stdout pipes. It does not use CLI plaintext export or a TCP service.
IPC frames, queued writes, pending requests, KDF parameters, and file sizes have bounds. Malformed responses and timeouts invalidate the connection.

## Architecture and storage

| Component | Responsibility |
| --- | --- |
| `venc-crypto` | Argon2id, HKDF-SHA256, XChaCha20-Poly1305, zeroizing key buffers |
| `venc-vault` | Encrypted metadata, file/directory operations, session ownership, password changes |
| `venc-cli` | Terminal commands and the extension's IPC server |
| `vscode-extension` | Vault lifecycle UI and virtual FileSystemProvider |

Argon2id v19 derives two independent 32-byte keys sequentially, using separate 16-byte salts and fixed parameters of 64 MiB, 3 iterations, and parallelism 1.
HKDF-SHA256 combines the keys to wrap a randomly generated 256-bit vault master key (VMK).
Separate HKDF domains derive metadata and file-key wrapping keys from the VMK.
Every file write creates a fresh file encryption key, object ID, and random 24-byte nonces.
AEAD associated data binds format version, purpose, vault ID, and object ID.

```text
my-vault/
├── vault.json       # public parameters and wrapped VMK
├── metadata.enc     # encrypted paths, directories, times, and wrapped file keys
├── .session.lock    # exclusive process lock
└── objects/
    └── <random-id>.enc
```

The prototype v1 format stores byte arrays in JSON. File and decrypted metadata limits are each 16 MiB.
The current reader accepts early metadata without directory/timestamp fields; old binaries cannot read the updated metadata. The format is not yet stable.

Writes sync a new immutable encrypted object before atomically replacing encrypted metadata. Password changes replace only `vault.json`.
Unix builds also sync directories and create files with mode 0600 and directories with mode 0700.
A commit error locks the session to prevent further writes from stale in-memory state. Power-loss guarantees still depend on the OS/filesystem and have not been exhaustively tested.

Replaced/deleted objects are retained to preserve crash safety; garbage collection is not implemented.
Initialization failures can leave an incomplete new directory. Do not reuse it automatically or treat it as a completed vault.

## Remaining limits

This is an unaudited prototype. Recovery keys, chunk encryption, recursive folder import, automatic garbage collection, and rollback detection are not implemented.
Losing either password prevents recovery. Changing passwords does not revoke old snapshots containing the same master key.
Object counts, sizes, and filesystem times remain visible. OS swap, crash dumps, other extensions, language servers, Save As, and editor backups can retain plaintext.
Path checks reject symlinks in vault objects but do not fully prevent a hostile local process racing filesystem changes.
Use trusted host storage and independent encrypted backups; see [SECURITY.md](SECURITY.md) for exact guarantees and open work.

API references: [RustCrypto Argon2](https://docs.rs/argon2/0.5.3/argon2/), [RustCrypto XChaCha20-Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).
