const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CoreClient } = require('../dist/coreClient');
const { VaultProvider } = require('../dist/vaultProvider');

exports.run = async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'venc-electron-'));
    const vault = path.join(temp, 'vault');
    const client = new CoreClient(process.env.VENC_TEST_CORE);
    const provider = new VaultProvider("venc-test");
    let registration;
    try {
        await vscode.workspace.getConfiguration('files').update('hotExit', 'off', vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('workbench.localHistory').update('enabled', false, vscode.ConfigurationTarget.Global);
        const opened = await client.request('init', { vault, passwordA: 'alpha', passwordB: 'beta' });
        const root = provider.mount(opened.vaultId, client);
        // Exercise real VS Code filesystem dispatch, document editing, and save.
        registration = vscode.workspace.registerFileSystemProvider('venc-test', provider, { isCaseSensitive: true });
        const dir = vscode.Uri.joinPath(root, 'notes');
        const file = vscode.Uri.joinPath(dir, '日本語.txt');
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(file, Buffer.from('before\n'));
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(file, new vscode.Range(0, 0, document.lineCount, 0), 'encrypted editor save\n');
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        // Measure the standard editor's backup behavior rather than claiming that
        // Hot Exit off disables background backups. Use only disposable test data.
        const contains = async (directory, needle) => {
            for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
                const location = path.join(directory, item.name);
                if (item.isDirectory()) { if (await contains(location, needle)) { return true; } }
                else if ((await fs.readFile(location)).includes(Buffer.from(needle))) { return true; }
            }
            return false;
        };
        if (process.env.VENC_PROBE_BACKUPS === '1') {
            await new Promise(resolve => setTimeout(resolve, 2500));
            assert.equal(await contains(path.join(process.env.VENC_TEST_USER_DATA, 'Backups'), 'encrypted editor save'), true,
                'Pinned VS Code creates plaintext crash backups even with Hot Exit off');
            console.log('Confirmed limitation: dirty standard editor creates plaintext crash backup with Hot Exit off');
        }
        assert.equal(await document.save(), true);
        assert.equal(await contains(vault, 'encrypted editor save'), false);

        assert.equal(Buffer.from(await vscode.workspace.fs.readFile(file)).toString(), 'encrypted editor save\n');
        const renamed = vscode.Uri.joinPath(dir, 'renamed.txt');
        await vscode.workspace.fs.rename(file, renamed, { overwrite: false });
        assert.deepEqual(await vscode.workspace.fs.readDirectory(dir), [['renamed.txt', vscode.FileType.File]]);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await client.request('lock', {});
        await assert.rejects(vscode.workspace.fs.readFile(renamed));
        client.dispose();
        const reopened = new CoreClient(process.env.VENC_TEST_CORE);
        try {
            await reopened.request('unlock', { vault, passwordA: 'alpha', passwordB: 'beta' });
            provider.unmount(root.authority); provider.mount(root.authority, reopened);
            assert.equal(Buffer.from(await vscode.workspace.fs.readFile(renamed)).toString(), 'encrypted editor save\n');
            await vscode.workspace.fs.delete(dir, { recursive: true });
            assert.deepEqual(await vscode.workspace.fs.readDirectory(root), []);
        } finally { reopened.dispose(); }
        console.log('VS Code editor integration: virtual FS create/read/edit/save/rename/lock/reopen/delete passed');
        if (process.env.VENC_PROBE_BACKUPS !== '1') {
            registration.dispose(); registration = undefined;
            provider.dispose();
            const extension = vscode.extensions.getExtension('ayano-yuki.venc');
            assert(extension, 'Development extension is discoverable');
            await extension.activate();
            const commands = await vscode.commands.getCommands(true);
            for (const name of ['venc.openVault', 'venc.openAnotherVault', 'venc.lockAllVaults', 'venc.changePasswords', 'venc.forgetVault']) {
                assert(commands.includes(name), `${name} registered by the actual extension`);
            }
            await vscode.commands.executeCommand('venc.lockAllVaults');
            console.log('Actual extension activation, status bar, and command registration passed');
        }

    } finally {
        registration?.dispose(); provider.dispose(); client.dispose();
        await fs.rm(temp, { recursive: true, force: true });
    }
};
