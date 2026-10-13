import * as vscode from 'vscode';
import { VaultProvider } from './vaultProvider';

interface Node { uri: vscode.Uri; name: string; directory: boolean }
export class ProtectedFiles implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly events = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.events.event;
    private readonly subscription: vscode.Disposable;
    constructor(private readonly provider: VaultProvider, private readonly roots: () => { uri: vscode.Uri; name: string }[]) {
        this.subscription = provider.onDidChangeFile(() => this.refresh());
    }
    refresh(): void { this.events.fire(undefined); }
    getTreeItem(node: Node): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, node.directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.resourceUri = node.uri;
        item.contextValue = node.directory ? 'vencDirectory' : 'vencFile';
        if (!node.directory) { item.command = { command: 'venc.openProtectedFile', title: 'Open in Protected Editor', arguments: [node.uri] }; }
        return item;
    }
    async getChildren(node?: Node): Promise<Node[]> {
        if (!node) { return this.roots().map(root => ({ ...root, directory: true })); }
        if (!node.directory) { return []; }
        try {
            return (await this.provider.readDirectory(node.uri)).map(([name, type]) => ({ name, uri: vscode.Uri.joinPath(node.uri, name), directory: type === vscode.FileType.Directory }));
        } catch { return []; } // A revoked root is removed on refresh.
    }
    dispose(): void { this.subscription.dispose(); this.events.dispose(); }
}
