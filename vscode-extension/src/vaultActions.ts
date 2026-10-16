import * as vscode from 'vscode';
import * as path from 'node:path';
import { VaultProvider, SCHEME } from './vaultProvider';

export function itemUri(value: unknown): vscode.Uri | undefined {
    const uri = value instanceof vscode.Uri ? value : value && typeof value === 'object' && 'uri' in value ? value.uri : undefined;
    if (!uri) { return; }
    if (!(uri instanceof vscode.Uri) || uri.scheme !== SCHEME || uri.query || uri.fragment) { throw new Error('Choose a vault file or folder in the venc sidebar.'); }
    return uri;
}
export function validateName(name: string): string | undefined {
    return !name || name === '.' || name === '..' || /[\\/\0:]/.test(name) || Buffer.byteLength(name) > 255 ? 'Enter a name without slashes, colon, or . / .. components (up to 255 UTF-8 bytes).' : undefined;
}
export class VaultActions {
    constructor(private readonly provider: VaultProvider, private readonly chooseRoot: () => Promise<vscode.Uri | undefined>,
        private readonly open: (uri: vscode.Uri) => Promise<void>, private readonly close: (uri: vscode.Uri) => Promise<void>) {}
    async folder(value?: unknown): Promise<vscode.Uri | undefined> {
        const uri = itemUri(value) ?? await this.chooseRoot();
        if (!uri) { return; }
        const stat = await this.provider.stat(uri);
        return stat.type === vscode.FileType.Directory ? uri : uri.with({ path: path.posix.dirname(uri.path) });
    }
    async create(value: unknown, directory: boolean): Promise<void> {
        const parent = await this.folder(value); if (!parent) { return; }
        const name = await vscode.window.showInputBox({ prompt: directory ? 'New encrypted folder name' : 'New encrypted file name', validateInput: validateName });
        if (name === undefined) { return; }
        const invalid = validateName(name); if (invalid) { throw new Error(invalid); }
        const uri = vscode.Uri.joinPath(parent, name);
        if (directory) {
            try { await this.provider.stat(uri); throw new Error('A file or folder already exists at that path.'); }
            catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
            await this.provider.createDirectory(uri);
        } else {
            await this.provider.writeFile(uri, new Uint8Array(), { create: true, overwrite: false });
            await this.open(uri);
        }
    }
    async rename(value: unknown): Promise<void> {
        const source = itemUri(value); if (!source || source.path === '/') { throw new Error('Choose a file or folder; vault roots cannot be renamed here.'); }
        await this.provider.stat(source);
        const name = await vscode.window.showInputBox({ prompt: 'New name inside the encrypted vault', value: path.posix.basename(source.path), validateInput: validateName });
        if (name === undefined) { return; }
        const invalid = validateName(name); if (invalid) { throw new Error(invalid); }
        const target = source.with({ path: path.posix.join(path.posix.dirname(source.path), name) });
        if (target.toString() === source.toString()) { return; }
        await this.close(source);
        await this.provider.rename(source, target, { overwrite: false });
    }
    async delete(value: unknown): Promise<void> {
        const uri = itemUri(value); if (!uri || uri.path === '/') { throw new Error('Choose a file or folder; vault roots cannot be deleted here.'); }
        const stat = await this.provider.stat(uri);
        const consent = await vscode.window.showWarningMessage(`Delete “${path.posix.basename(uri.path)}”${stat.type === vscode.FileType.Directory ? ' and its contents' : ''} from this encrypted vault?`, { modal: true }, 'Delete');
        if (consent !== 'Delete') { return; }
        await this.close(uri);
        await this.provider.delete(uri, { recursive: stat.type === vscode.FileType.Directory });
    }
}
