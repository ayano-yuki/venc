# venc for VS Code

[English](README.md) | [日本語](README.ja.md)

Edit a two-password encrypted vault through a `venc://<vault-id>/` virtual workspace.
A Rust child process authenticates and encrypts saves. The extension does not create decrypted temporary files.

**The standard editor can still create plaintext crash backups.** Hot Exit off does not disable background backup creation. This is a tested limitation, not a no-plaintext-on-disk guarantee.

## Install and open

1. Install the VSIX with **Extensions: Install from VSIX...** in desktop VS Code 1.95+.
2. If using a custom core, set **venc.corePath** to its absolute executable path on the extension host. Use only a trusted executable.
3. Run **venc: Create Vault** to select a parent and a new directory name, or **venc: Open Vault** to select an existing vault.
4. Review the backup limitation. If offered, explicitly approve disabling Hot Exit and Local History in user settings.
5. Enter both passwords. A folder named **venc: your-vault-name** appears in Explorer.
6. Create folders/files, edit, and save as usual. A file can contain at most 16 MiB.

Executable and protocol setup errors are checked before requesting passwords. Cancelling a password prompt makes no authenticated change.
Adding the first workspace folder can restart the extension host. Choose **Unlock** in the locked-workspace notification or run **Open Vault** again after the restart. Passwords are never restored automatically.

## Commands and session state

| Command | Behavior |
| --- | --- |
| Create Vault | Create a new encrypted directory; existing directories are refused |
| Open Vault | Unlock a restored vault folder, or choose an existing vault |
| Open Another Vault | Browse for an additional vault even when a locked folder is present |
| Lock Vault | Select an open vault; save and close its editors before releasing keys |
| Lock All Vaults | Lock open vaults in order; stop if saving fails or locking is cancelled |
| Change Vault Passwords | Reauthenticate both current passwords and confirm a new pair |
| Forget Vault Location | Lock the vault if open, then delete its remembered physical location |

The status bar shows open and locked counts. Click it to lock an open vault or open a locked one.
Multiple vaults use their directory names and physical paths in selection lists. Physical location metadata is not secret.
A restored folder is authenticated against its expected vault ID; a different vault substituted at that path is refused.

A cancelled lock, failed save, or cancelled editor close keeps the vault open. Hidden dirty notebook documents are included in the save check.
Locking revokes the provider before releasing the core session; an in-flight read cannot return its result after that revocation.
The locked workspace URI remains so the host need not restart again.

Changing passwords does not re-encrypt file contents. **Old snapshots still work with their older passwords.**
No recovery key exists. Use distinct, strong passwords and retain independent encrypted backups.

Removing a vault workspace folder disconnects its session. A core failure, timeout, malformed response, or unsafe history-setting change also invalidates access.
Unexpected disconnects are reported, and editor buffers may remain so they can be saved after reauthentication. Emergency disconnects do not discard unsaved content or claim to erase all plaintext.

## Settings and trust

`venc.corePath` is a machine setting. An empty value uses the bundled `bin/venc` (`bin/venc.exe` on Windows).
The extension requires a trusted workspace and runs on the workspace host. In SSH/WSL/containers, the executable and vault paths refer to that host.
Browser-only VS Code is unsupported. A native executable must match the host OS/CPU and runtime requirements.
The core must implement the initial protocol handshake. Incompatible binaries are refused before asking for passwords. Cores that omit the password-change capability are refused for that command.

The opening flow checks `files.hotExit: "off"` and `workbench.localHistory.enabled: false`.
Approving the setting change affects **other files in your user profile** and is not automatically reverted.
Workspace overrides must also meet these settings. A later unsafe change disconnects the vault.
The extension remembers only vault IDs and physical directory paths in local extension state. **Forget Vault Location** removes that mapping, leaves the workspace URI, and does not delete the encrypted vault.

## Plaintext storage limits

In a normal VS Code 1.95.3 profile, an unsaved virtual text document is backed up in plaintext even with Hot Exit off.
The settings above reduce persistence paths but do not prevent all backups or remove older copies.

For a strict no-plaintext-on-disk requirement, separately configure and validate an isolated environment whose VS Code user data, workspace state, and backup locations use appropriate memory-backed storage.
venc does not configure or verify that environment. RAM storage alone does not address swap, hibernation, crash dumps, or other processes.
A custom editor with encrypted backup handling is a separate future design; it is not implemented.

Other extensions, language servers, editor search, clipboard operations, Save As, and OS facilities may access plaintext.
Lock closes recognized standard vault tabs and releases Rust keys; it does not securely erase VS Code memory, third-party copies, or existing backups.
Do not add untrusted vault configuration to a trusted workspace or assume encrypted content is safe to execute.
See [the security model](../SECURITY.md) for remaining work.

## Develop, test, and package

Requirements: Rust, a C linker, Node.js 22.12+, and npm. From the repository root:

```sh
cargo build --locked
cd vscode-extension
npm ci --ignore-scripts
npm test
npm run test:integration
npm run test:backups
```

Provider tests run real Rust processes and cover filesystem contracts, authentication, password changes, lock cancellation, dirty notebooks, queue limits, malformed responses, and revocation races.
`test:integration` pins VS Code 1.95.3 and exercises real document editing and saving in an isolated development profile.
`test:backups` runs a disposable normal installed-extension profile to check actual disk backup behavior; development profiles can omit that backup location.
Linux editor tests need a display/Xvfb and Electron libraries. Set `VENC_TEST_CORE` to select another core binary.

Open this directory in VS Code, set `venc.corePath`, and press F5 to launch the development host.
Create a host-specific distributable with:

```sh
npm run package
```

The script builds the core for the current host, copies the new binary to `bin/`, and packages compiled extension code and both README languages.
Cross-platform `--target` values are refused; build on a matching host. Dynamic/Nix runtime dependencies must be validated on the target machine.
For Linux builds with static libraries available, `RUSTFLAGS="-C target-feature=+crt-static" npm run package` can produce a static core.
The provided Linux x64 VSIX was verified locally. macOS and Windows packages are not yet locally verified.

Source references: [VS Code FileSystemProvider](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider), [VS Code backup tracker](https://github.com/microsoft/vscode/blob/1.95.3/src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts).
