# venc for VS Code

[English](README.md) | [日本語](README.ja.md)

[Step-by-step usage guide (Japanese)](../USAGE.md)

Edit a two-password encrypted vault with a protected UTF-8 editor and a `venc://<vault-id>/` virtual workspace.
Rust authenticates, encrypts saves, and encrypts unsaved crash drafts. Both passwords are required; this is not two-factor authentication.

**Protected mode is the default.** Document contents are kept out of VS Code's standard text model, filesystem reads are denied, and custom-editor backups contain encrypted data in the vault. Save As is denied.
This closes the standard editor's plaintext backup path. It does not isolate plaintext memory from a compromised host or erase swap, dumps, clipboard copies, or older backups.

## Install and edit

1. Install a host-specific VSIX using **Extensions: Install from VSIX...** in desktop VS Code 1.95+.
2. Click the **venc vault icon** in the Activity Bar to open its sidebar. Use **Create Vault** or **Open Vault** in the welcome view, or the toolbar buttons, to choose a vault.
3. Enter both passwords. A **venc: your-vault-name** workspace folder appears.
4. Create folders and empty files from the **Protected Files** toolbar or folder context menu. New files open directly; click existing files to edit them. Explorer also offers **venc: Open in Protected Editor**.
5. Edit UTF-8 text and press Ctrl/Cmd+S. Each file is limited to 16 MiB. Binary files and malformed UTF-8 are refused without changing the file.

Ordinary Explorer double-click and text-based extensions cannot read vault contents in protected mode. Use the dedicated view or context command.
The protected editor supports literal find/replace (Ctrl/Cmd+F or H), VS Code Undo/Redo, Tab insertion, and explicit LF/CRLF selection. Undo text is bounded to 32 MiB and released on close. It does not provide language servers, notebooks, syntax highlighting, whole-vault search, or plaintext export.
BOMs and LF/CRLF endings outside the edited range are preserved; inserted line breaks use the document’s preferred ending; the line-ending selector performs explicit conversion.
Sidebar rename/delete offers to save and close affected documents first; cancellation leaves the paths unchanged.

Adding the first workspace folder can restart the extension host. Run **Open Vault** again after the restart. Passwords and keys are never restored automatically.
If a restored editor reports a locked vault, unlock it first, then retry opening the editor. Existing encrypted backup IDs require the same vault and document path. A stale restored draft cannot overwrite a more recently saved file; preserve the draft in memory before using Revert.

## Activity Bar and sidebar

The vault icon opens a dedicated **venc** sidebar. **Protected Files** lists remembered vaults and current vault workspace folders, with Locked/Unlocked status.
Click a locked vault to enter both passwords; expand an unlocked vault to browse folders and open files in the protected editor.
Locked vaults do not expose their file tree or request decrypted directory metadata.

The toolbar provides Create Vault, Open Another Vault, Lock All Vaults, and Refresh. Each unlocked vault has its own lock action, and each locked vault has an unlock action.
File/folder creation and rename/delete are available directly in the venc sidebar. Affected editors are saved and closed with consent before path changes. The regular workspace Explorer remains available. The status bar counts the same open/locked vaults as the sidebar.

## Commands and locking

| Command | Behavior |
| --- | --- |
| Create Vault | Create a new vault; existing directories are refused |
| Open Vault / Open Another Vault | Authenticate an existing/restored vault or browse for another |
| Open in Protected Editor | Open a vault text file without a standard TextDocument |
| Lock Vault / Lock All Vaults | Save and close editors, revoke access, then release Rust keys |
| Change Vault Passwords | Require both current passwords and confirm a new pair |
| Forget Vault Location | Lock, then remove the remembered physical location |

The status bar shows open/locked counts. A cancelled lock, failed save, or cancelled close leaves the session open.
Saving checks the file's immutable object revision. A conflict or edits arriving during a save leave the document dirty.

Removing a workspace folder, changing access mode, or losing the core connection revokes access and closes protected panels, releasing their content references. **Changes since the last completed encrypted backup can be lost during an unexpected disconnect.** Encrypted orphan drafts may remain; Recover Encrypted Drafts can restore them as new encrypted files; Vault Storage and Cleanup reclaims unreferenced objects older than 24 hours while retaining drafts and unrecognized files.
Normal locking saves before closing. Locking is not secure erasure of renderer/JavaScript/OS memory.

Changing passwords rewraps the same master key. Old vault snapshots still work with their old passwords; neither current file data nor encrypted drafts are re-encrypted.
Losing either password prevents recovery. Keep independent encrypted backups.

## Settings and compatibility

`venc.corePath` is a machine setting: an empty value uses bundled `bin/venc` (`bin/venc.exe` on Windows). A custom value must be an absolute path to a trusted executable on the workspace host.
The protocol and protected-editor capability are checked before requesting passwords.
SSH/WSL/container vault paths and executables belong to that host. Browser-only VS Code is unsupported. Workspace Trust is required.

`venc.allowPlaintextAccess` defaults to `false`. Enabling it explicitly permits the standard FileSystemProvider to return plaintext for native editors and other extensions. **Compatibility mode can write plaintext crash backups even with Hot Exit disabled**, as reproduced in VS Code 1.95.3.
Compatibility opening requires acknowledging that risk, `files.hotExit: "off"`, and `workbench.localHistory.enabled: false`. Consent to change these user settings affects other files and is not automatically reverted. Workspace overrides must also match.
Protected mode does not change these global settings. Changing access mode locks all vaults; save first. Unsafe history settings disconnect compatibility sessions.

Vault IDs, physical locations, document paths/URIs, and opaque backup references may appear in VS Code profile metadata. File-name confidentiality applies to vault metadata, not the editor's recent-file/workspace records.
Neither mode deletes previous plaintext backups or exports. Upgrading from 0.2.x does not erase copies made by its native editor.
Do not trust or execute vault configuration merely because its contents were encrypted. See [the security model](../SECURITY.md).

Choose **venc: Choose Editor Mode** to select protected or standard editing. Mode changes save and lock vaults first; standard editing requires explicit consent to plaintext access and backup risks.

Use **venc: Import Files** or drop extension-host files onto a vault folder to encrypt them directly. Originals remain; existing vault files are never overwritten. Imports are cancellable, with at most 100 files per operation and 16 MiB per file. Cross-host drops without host paths require the file picker.

Idle auto-lock defaults to five minutes per vault (`venc.idleTimeoutMinutes`, 0 disables). The status bar shows the next expiry. Protected buffers are frozen, acknowledged, checkpointed, and closed before keys are released; Recover Encrypted Drafts restores unsaved edits. New activity aborts an in-flight expiry. Dirty compatibility editors pause auto-lock instead of being discarded.

## Develop, test, and package

Requirements: Rust, a C linker, Node.js 22.12+, and npm. From the repository root:

```sh
cargo build --locked
cd vscode-extension
npm ci --ignore-scripts
npm test
npm run test:integration
npm run test:backups
npm run package
```

Tests use real Rust processes. The normal-profile backup probe waits for VS Code's actual custom working-copy backup callback, decrypts the draft, checks for document plaintext in the vault and profile, and reproduces the native editor's unsafe backup as a control.
A development/test profile alone cannot establish backup behavior. Linux editor tests need a display/Xvfb and Electron libraries. `VENC_TEST_CORE` selects another binary.

Normal-profile editor tests now drive the real renderer through the test-only Chromium debugging connection: IME composition, typing, Undo/Redo, literal replacement, and keyboard save. They then kill the disposable VS Code process group, restart the same profile, and recover a draft through the real picker/input UI without overwriting the saved file. The debugging port is confined to tests and localhost. CI runs this on the minimum editor version and stable; CI configuration is not a claim that remote jobs have passed.

The packaging script builds the current-host core, atomically stages it in `bin/`, and packages compiled code with both README languages and the security model. Build other OS/CPU packages on their matching hosts and verify runtime dependencies.
Linux static builds require static libraries and `RUSTFLAGS="-C target-feature=+crt-static"`. Local validation is Linux x64; other platforms and an independent security audit remain pending.

References: [VS Code Tree View and Activity Bar containers](https://code.visualstudio.com/api/extension-guides/tree-view), [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors), [CustomEditorProvider API](https://code.visualstudio.com/api/references/vscode-api#CustomEditorProvider).
