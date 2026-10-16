import * as vscode from 'vscode';
import { CoreConnection, CoreError } from './coreClient';

export const SCHEME = 'venc';
export interface BackupInfo { id: string; path: string; size: number; modified: number }
export interface BackupPage { entries: BackupInfo[]; next: string | null; invalid: number }
interface CoreStat { kind: 'file' | 'directory'; size: number; ctime: number; mtime: number }
export class VaultProvider implements vscode.FileSystemProvider, vscode.Disposable {
    constructor(private readonly scheme = SCHEME, private readonly allowPlaintext = () => false) {}
    guardMutation: (uri: vscode.Uri) => void = () => {};
    private readonly events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.events.event;
    private readonly mounts = new Map<string, CoreConnection>();
    mount(authority: string, client: CoreConnection): vscode.Uri {
        if (client.closed) { throw vscode.FileSystemError.Unavailable('Vault connection is closed.'); }
        if (this.mounts.has(authority)) { throw new Error('Vault already mounted.'); }
        this.mounts.set(authority, client);
        const root = vscode.Uri.from({ scheme: this.scheme, authority, path: '/' });
        this.events.fire([{ type: vscode.FileChangeType.Created, uri: root }]);
        return root;
    }
    unmount(authority: string): void {
        if (!this.mounts.delete(authority)) { return; }
        this.events.fire([{ type: vscode.FileChangeType.Deleted, uri: vscode.Uri.from({ scheme: this.scheme, authority, path: '/' }) }]);
    }
    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        // All writes pass through this provider. The Rust core holds an exclusive disk lock.
        return new vscode.Disposable(() => {});
    }
    private path(uri: vscode.Uri): string {
        if (uri.scheme !== this.scheme || uri.query || uri.fragment || !uri.path.startsWith('/')
            || (uri.path !== '/' && uri.path.slice(1).split('/').some(p => !p || p === '.' || p === '..'))
            || /[\\\0:]/.test(uri.path)) { throw vscode.FileSystemError.NoPermissions(uri); }
        return uri.path.slice(1);
    }
    private async call<T>(uri: vscode.Uri, method: string, params: Record<string, unknown> = {}): Promise<T> {
        const path = this.path(uri);
        const client = this.mounts.get(uri.authority);
        if (!client || client.closed) { throw vscode.FileSystemError.Unavailable('Vault is locked.'); }
        try {
            const result = await client.request<T>(method, { path, ...params });
            if (this.mounts.get(uri.authority) !== client || client.closed) {
                if (result && typeof result === 'object' && 'data' in result) { (result as { data: unknown }).data = ''; }
                throw vscode.FileSystemError.Unavailable('Vault was locked during the operation.');
            }
            return result;
        }
        catch (error) {
            if (error instanceof CoreError) {
                switch (error.code) {
                    case 'FileNotFound': throw vscode.FileSystemError.FileNotFound(uri);
                    case 'FileExists': throw vscode.FileSystemError.FileExists(uri);
                    case 'FileNotADirectory': throw vscode.FileSystemError.FileNotADirectory(uri);
                    case 'FileIsADirectory': throw vscode.FileSystemError.FileIsADirectory(uri);
                    case 'NoPermissions': throw vscode.FileSystemError.NoPermissions(uri);
                }
                throw vscode.FileSystemError.Unavailable(error.message);
            }
            throw vscode.FileSystemError.Unavailable('Vault operation failed.');
        }
    }
    private invalid(uri: vscode.Uri): never {
        const client = this.mounts.get(uri.authority);
        this.unmount(uri.authority); client?.dispose?.();
        throw vscode.FileSystemError.Unavailable('Invalid core result; vault locked.');
    }
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const stat = await this.call<CoreStat>(uri, 'stat');
        if (!stat || !['file', 'directory'].includes(stat.kind) || !Number.isSafeInteger(stat.size) || stat.size < 0
            || stat.size > 16 * 1024 * 1024 || !Number.isSafeInteger(stat.ctime) || stat.ctime < 0
            || !Number.isSafeInteger(stat.mtime) || stat.mtime < 0) { this.invalid(uri); }
        return { ...stat, type: stat.kind === 'file' ? vscode.FileType.File : vscode.FileType.Directory };
    }
    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const entries = await this.call<[string, string][]>(uri, 'readDirectory');
        if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || entry.length !== 2
            || typeof entry[0] !== 'string' || !entry[0] || entry[0] === '.' || entry[0] === '..' || /[\\/\0:]/.test(entry[0])
            || !['file', 'directory'].includes(entry[1]))) { this.invalid(uri); }
        return entries.map(([name, kind]) => [name, kind === 'file' ? vscode.FileType.File : vscode.FileType.Directory]);
    }
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (!this.allowPlaintext()) { throw vscode.FileSystemError.NoPermissions('Open this file with venc: Open in Protected Editor. Plaintext filesystem access is disabled.'); }
        const result = await this.call<{ data: string }>(uri, 'readFile');
        if (!result || typeof result.data !== 'string' || result.data.length > 4 * Math.ceil((16 * 1024 * 1024) / 3)
            || result.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(result.data)
            || result.data.slice(0, -2).includes('=') || (result.data.endsWith('==') && result.data.length < 4)) { this.invalid(uri); }
        const bytes = Buffer.from(result.data, 'base64');
        const canonical = bytes.toString('base64') === result.data; result.data = '';
        if (!canonical) { bytes.fill(0); this.invalid(uri); }
        if (bytes.length > 16 * 1024 * 1024) { bytes.fill(0); this.invalid(uri); }
        return bytes;
    }
    async readDocument(uri: vscode.Uri, backup?: string): Promise<{ text: string; revision: string }> {
        const result = await this.call<{ data: string; revision: string }>(uri, backup ? 'readBackup' : 'readDocument', backup ? { backup } : {});
        if (!result || typeof result.revision !== 'string' || !/^[a-f0-9]{32}$/.test(result.revision)
            || typeof result.data !== 'string' || result.data.length > 4 * Math.ceil((16 * 1024 * 1024) / 3)) { this.invalid(uri); }
        const bytes = Buffer.from(result.data, 'base64');
        if (bytes.toString('base64') !== result.data || bytes.length > 16 * 1024 * 1024) { bytes.fill(0); this.invalid(uri); }
        result.data = '';
        try {
            // Reject binary and malformed UTF-8 instead of silently corrupting them.
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            if (text.includes('\0')) { throw new Error('Binary file'); }
            return { text, revision: result.revision };
        } catch { throw vscode.FileSystemError.NoPermissions('The protected editor supports UTF-8 text without NUL bytes.'); }
        finally { bytes.fill(0); }
    }
    async writeDocument(uri: vscode.Uri, text: string, revision: string): Promise<string> {
        const result = await this.call<{ revision: string }>(uri, 'writeDocument', { data: this.encodeText(text), revision });
        if (!result || typeof result.revision !== 'string' || !/^[a-f0-9]{32}$/.test(result.revision)) { this.invalid(uri); }
        this.changed(uri, vscode.FileChangeType.Changed);
        return result.revision;
    }
    private encodeText(text: string): string {
        if (Buffer.byteLength(text) > 16 * 1024 * 1024) { throw vscode.FileSystemError.NoPermissions('File exceeds the 16 MiB limit.'); }
        const bytes = Buffer.from(text, 'utf8');
        try {
            if (bytes.toString('utf8') !== text) { throw vscode.FileSystemError.NoPermissions('Invalid Unicode text.'); }
            return bytes.toString('base64');
        } finally { bytes.fill(0); }
    }
    async createBackup(uri: vscode.Uri, text: string, revision: string): Promise<string> {
        const result = await this.call<{ backup: string }>(uri, 'createBackup', { data: this.encodeText(text), revision });
        if (!result || typeof result.backup !== 'string' || !/^[a-f0-9]{32}$/.test(result.backup)) { this.invalid(uri); }
        return result.backup;
    }
    async deleteBackup(uri: vscode.Uri, backup: string): Promise<void> { await this.call(uri, 'deleteBackup', { backup }); }
    async listBackups(root: vscode.Uri, after = ''): Promise<BackupPage> {
        const page = await this.call<BackupPage>(root, 'listBackups', { after });
        if (!page || !Array.isArray(page.entries) || page.entries.length > 20 || !Number.isSafeInteger(page.invalid) || page.invalid < 0
            || (page.next !== null && (typeof page.next !== 'string' || !/^[a-f0-9]{32}$/.test(page.next) || page.next <= after))
            || page.entries.some(b => !b || typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id) || typeof b.path !== 'string'
                || !b.path || b.path.length > 4096 || b.path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\0:]/.test(b.path)
                || !Number.isSafeInteger(b.size) || b.size < 0 || b.size > 16 * 1024 * 1024 || !Number.isSafeInteger(b.modified) || b.modified < 0)) { this.invalid(root); }
        return page;
    }
    async recoverBackup(target: vscode.Uri, backup: string): Promise<void> {
        await this.call(target, 'recoverBackup', { backup });
        this.changed(target, vscode.FileChangeType.Created);
    }
    private changed(uri: vscode.Uri, type: vscode.FileChangeType): void {
        const parent = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) || '/' });
        this.events.fire([{ type, uri }, { type: vscode.FileChangeType.Changed, uri: parent }]);
    }
    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        if (content.byteLength > 16 * 1024 * 1024) { throw vscode.FileSystemError.NoPermissions('File exceeds the 16 MiB limit.'); }
        let existed = false;
        try { await this.stat(uri); existed = true; }
        catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
        if (!this.allowPlaintext() && (existed || content.byteLength || !options.create)) {
            throw vscode.FileSystemError.NoPermissions('Use the protected editor to write vault contents.');
        }
        await this.call(uri, 'writeFile', { ...options, data: Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('base64') });
        this.changed(uri, existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
    }
    async createDirectory(uri: vscode.Uri): Promise<void> {
        this.path(uri);
        const missing: vscode.Uri[] = [];
        const parts = uri.path.slice(1).split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            const ancestor = uri.with({ path: '/' + parts.slice(0, i).join('/') });
            try { await this.stat(ancestor); }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; }
                missing.push(ancestor);
            }
        }
        await this.call(uri, 'createDirectory');
        for (const created of missing) { this.changed(created, vscode.FileChangeType.Created); }
    }
    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        this.guardMutation(uri);
        await this.call(uri, 'delete', options); this.changed(uri, vscode.FileChangeType.Deleted);
    }
    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        this.guardMutation(oldUri); this.guardMutation(newUri);
        if (oldUri.authority !== newUri.authority) { throw vscode.FileSystemError.NoPermissions('Moving between vaults is unsupported.'); }
        const target = this.path(newUri);
        if (oldUri.toString() === newUri.toString()) { await this.stat(oldUri); return; }
        await this.call(oldUri, 'rename', { source: this.path(oldUri), target, ...options });
        this.changed(oldUri, vscode.FileChangeType.Deleted); this.changed(newUri, vscode.FileChangeType.Created);
    }
    dispose(): void { this.mounts.clear(); this.events.dispose(); }
}
