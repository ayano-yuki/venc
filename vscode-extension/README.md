# venc for VS Code

二つのパスワードで暗号化 Vault を開き、`venc://<vault-id>/` の仮想ファイルを編集する拡張です。
ファイルの保存は Rust 子プロセスが暗号化して処理します。拡張が復号用の一時ファイルを作ることはありません。

## 使用

1. VSIX を VS Code の「Extensions: Install from VSIX...」でインストールします。
2. コアを同梱しない場合は、`venc.corePath` に実行ファイルの**絶対パス**を指定します。
3. コマンドパレットから `venc: Create Vault` または `venc: Open Vault` を実行します。
4. 二つのパスワードを入力すると、Explorer に `venc Vault` が追加されます。
5. Explorer でファイル・フォルダを作成し、通常のエディタで編集・保存できます。
6. `venc: Lock Vault` でロックします。未保存の場合は保存を確認し、保存に失敗・キャンセルしたときは開いた状態を維持します。

フォルダの追加で VS Code の拡張ホストが再起動することがあります。
その場合は「Vault workspace is locked」の **Unlock**、または `venc: Open Vault` で再認証します。
ロック後もワークスペース URI は残ります。パスワードや鍵は再起動後に復元しません。
拡張は再接続用に Vault ID と実ディレクトリのパスだけを VS Code の拡張状態へ記録します。
リモート環境では拡張とコアはワークスペース側で動きます。コアのパスと Vault の場所はその環境のものを指定してください。
ブラウザ版 VS Code は子プロセスを利用できないため未対応です。

## 平文の保存に関する制約

**標準エディタを使う FileSystemProvider は、VS Code 全体の平文非保存を保証できません。**
VS Code 1.95.3 で、`files.hotExit: "off"` にしても、未保存のテキストがディスクのクラッシュ用バックアップへ
書かれることを実機テストで確認しています。Hot Exit の無効化はバックアップ生成そのものを止めません。

拡張は開く前にこの制約を表示し、Hot Exit と Local History を無効にする設定を確認します。
設定変更を選択すると**他のファイルにも適用されるユーザー設定**を変更します。自動で元へ戻しません。
この設定確認は漏洩経路を減らすためのもので、平文非保存の保証ではありません。
過去に作られたバックアップ・履歴も削除しません。

厳密にディスクへ平文を残さない用途では、VS Code のユーザーデータ・ワークスペース状態・バックアップを
含む保存先を RAM ファイルシステムなどへ置く隔離環境が別途必要です。本拡張はその環境を作成・検証しません。
別案として暗号化バックアップを制御できるカスタムエディタが必要ですが、今回は未実装です。
他の拡張機能、言語サーバー、検索、コピー、Save As、OS の swap・クラッシュダンプにも平文が渡る可能性があります。

ロックはコアの鍵を破棄し、仮想 FS を無効化して対象の標準エディタタブを閉じます。
VS Code のすべてのメモリ・外部拡張のコピー・既存バックアップの消去は保証しません。
コアのクラッシュや設定変更による緊急ロックでは、編集中のエディタバッファは残る場合があります。

参考: [VS Code WorkingCopyBackupTracker](https://github.com/microsoft/vscode/blob/1.95.3/src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts)、
[FileSystemProvider API](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider)。

## 開発・検証

リポジトリのルートで:

```sh
cargo build --locked
cd vscode-extension
npm ci --ignore-scripts
npm test
npm run test:integration
npm run test:backups
```

`npm test` は実際の Rust 子プロセスを使ってプロバイダを検証します。
`npm run test:integration` は VS Code 1.95.3 を取得し、隔離した一時ユーザープロファイルで
実際の文書編集・保存、名前変更、ロック、再解除、削除を検証します。
`npm run test:backups` は通常の拡張起動を使い、バックアップへの平文保存を再現・検証します。
開発モードではバックアップのディスク保存先が省略されるため、この検査を分けています。
Linux では GUI ディスプレイ（または Xvfb）と Electron 用のシステムライブラリが必要です。
`VENC_TEST_CORE` を指定すると別のコア実行ファイルでテストできます。

このディレクトリを VS Code で開き、`venc.corePath` を設定して F5 で開発用拡張ホストを起動できます。

配布用 VSIX は、対象 OS・CPU 向けにビルドしたコアを `bin/venc`（Windows は `bin/venc.exe`）へ入れて作成します。

```sh
# リポジトリのルートで実行（Linux x64 の例）
cargo build --release --locked
mkdir -p vscode-extension/bin
cp target/release/venc vscode-extension/bin/venc
cd vscode-extension
npm run package -- --target linux-x64
```

ビルド環境に由来する動的ライブラリや Nix の絶対パスが含まれる実行ファイルは、別端末で動くとは限りません。
対象環境で検証してください。コアを同梱しない VSIX では `venc.corePath` を設定します。
この変更で用意した Linux x64 VSIX は静的リンクしたコアを含みます。macOS・Windows 向けパッケージは未検証です。
ファイル上限は 16 MiB、不要な暗号化オブジェクトの回収とチャンク暗号化は未対応です。
