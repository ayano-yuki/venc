import * as vscode from 'vscode';
import { VaultProvider } from './vaultProvider';

export interface VaultRoot { uri: vscode.Uri; name: string; locked: boolean }
export interface Node { uri: vscode.Uri; name: string; directory: boolean; locked?: boolean; vault?: boolean }
export class ProtectedFiles implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly events = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.events.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly provider: VaultProvider, private readonly roots: () => VaultRoot[]) {
        this.subscription = provider.onDidChangeFile(() => this.refresh());
    }
    refresh(): void { this.events.fire(undefined); }
    getTreeItem(node: Node): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, node.directory && !node.locked ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = node.uri.toString();
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
        if (!node) { return this.roots().map(root => ({ ...root, directory: true, vault: true })); }
        if (!node.directory || node.locked) { return []; }
        try {
            return (await this.provider.readDirectory(node.uri)).map(([name, type]) => ({ name, uri: vscode.Uri.joinPath(node.uri, name), directory: type === vscode.FileType.Directory }));
        } catch { return []; } // A revoked root is removed on refresh.
    }
    dispose(): void { this.subscription.dispose(); this.events.dispose(); }
}
