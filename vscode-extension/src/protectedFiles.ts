import * as vscode from 'vscode';
import { VaultProvider } from './vaultProvider';

export interface VaultRoot { uri: vscode.Uri; name: string; locked: boolean }
export interface Node { uri: vscode.Uri; name: string; directory: boolean; locked?: boolean; vault?: boolean; error?: string; retry?: Node }
export class ProtectedFiles implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly events = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.events.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly provider: VaultProvider, private readonly roots: () => VaultRoot[]) {
        this.subscription = provider.onDidChangeFile(() => this.refresh());
    }
    private readonly nodes = new Map<string, Node>();
    refresh(): void { this.nodes.clear(); this.events.fire(undefined); }
    retry(uri: vscode.Uri): void { this.events.fire(this.nodes.get(uri.toString())); }
    getTreeItem(node: Node): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, node.directory && !node.locked ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = node.uri.toString() + (node.error ? '#load-error' : '');
        if (node.error) {
            item.contextValue = 'vencLoadError'; item.iconPath = new vscode.ThemeIcon('warning');
            item.description = 'Click to retry'; item.tooltip = node.error;
            item.command = { command: 'venc.retryFolder', title: 'Retry Folder', arguments: [node.uri] };
            return item;
        }
        item.resourceUri = node.uri;
        if (node.vault) {
            item.contextValue = node.locked ? 'vencLockedVault' : 'vencUnlockedVault';
            item.description = node.locked ? 'Locked' : 'Unlocked';
            item.iconPath = new vscode.ThemeIcon(node.locked ? 'lock' : 'unlock');
            item.tooltip = `${node.name}\n${node.locked ? 'Locked — click to unlock' : 'Unlocked'}\n${node.uri.authority}`;
            if (node.locked) { item.command = { command: 'venc.unlockVault', title: 'Unlock Vault', arguments: [node.uri] }; }
        } else {
            item.contextValue = node.directory ? 'vencDirectory' : 'vencFile';
            if (!node.directory) { item.command = { command: 'venc.openVaultFile', title: 'Open in Protected Editor', arguments: [node.uri] }; }
        }
        return item;
    }
    async getChildren(node?: Node): Promise<Node[]> {
        if (!node) {
            return this.roots().map(root => { const node = { ...root, directory: true, vault: true }; this.nodes.set(root.uri.toString(), node); return node; });
        }
        if (node.error) { return []; }
        this.nodes.set(node.uri.toString(), node);
        if (!node.directory || node.locked) { return []; }
        try {
            return (await this.provider.readDirectory(node.uri)).map(([name, type]) => ({ name, uri: vscode.Uri.joinPath(node.uri, name), directory: type === vscode.FileType.Directory }));
        } catch (error) {
            const root = this.roots().find(root => root.uri.authority === node.uri.authority);
            if (!root || root.locked) { return []; }
            const reason = error instanceof Error ? error.message.slice(0, 512) : 'Directory request failed';
            return [{ uri: node.uri, name: 'Could not load folder — Retry', directory: false, error: reason, retry: node }];
        }
    }
    dispose(): void { this.nodes.clear(); this.subscription.dispose(); this.events.dispose(); }
}
