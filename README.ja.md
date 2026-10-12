# venc — Vault ENCrypt

[English](README.md) | [日本語](README.ja.md)

venc は、二つのパスワードを必要とする暗号化 Vault です。Rust コア、CLI、VS Code 拡張を提供します。
Vault を `venc://` の仮想ワークスペースとして開き、VS Code で編集し、保存時に暗号化します。
両方のパスワードが必要ですが、**二要素認証ではありません**。

**セキュリティ上の境界:** 仮想 FS の保存先は暗号化されますが、VS Code の標準エディタは Hot Exit 無効時も平文のクラッシュ用バックアップを作成します。VS Code 1.95.3 で再現確認済みです。通常のプロファイルで「ディスクへ平文が残らない」とは考えないでください。[セキュリティモデル](SECURITY.md)と[拡張ガイド](vscode-extension/README.ja.md)を確認してください。

## VS Code 拡張

「Extensions: Install from VSIX...」で VSIX をインストールし、`venc: Create Vault` または `venc: Open Vault` を実行します。
二つのパスワードを入力すると、Vault 名付きの仮想フォルダが Explorer に追加されます。
ファイル・フォルダの作成、編集、保存、名前変更、削除を通常の操作で行えます。

ステータスバーに開いている Vault とロック中の Vault の数を表示します。
`Open Another Vault`、`Lock Vault`、`Lock All Vaults`、`Change Vault Passwords`、`Forget Vault Location` も利用できます。
ロックをキャンセルした場合や保存に失敗した場合は開いた状態を維持します。ワークスペースフォルダを取り除くとコアのセッションを解放します。

パスワードと鍵は拡張の状態に保存しません。再接続用の Vault ID と実ディレクトリのパスは記憶しますが、`Forget Vault Location` で削除できます。
設定、複数 Vault、リモート環境、配布については[拡張ガイド](vscode-extension/README.ja.md)を参照してください。

## ビルド・テスト

Rust ツールチェーン、C リンカー（Linux では GCC または Clang）、Node.js 22.12 以上、npm が必要です。
VS Code デスクトップ版 1.95 以上が対象です。ブラウザ版では Rust 子プロセスを起動できません。

```sh
cargo build --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cd vscode-extension
npm ci --ignore-scripts
npm test
```

テストは `target/debug/venc`（Windows は `venc.exe`）の実際の Rust コアを使います。
別のビルドを検証するには `VENC_TEST_CORE` に絶対パスを指定します。
実エディタのテストにはディスプレイまたは Xvfb と、Electron のシステムライブラリが必要です。

```sh
npm run test:integration
npm run test:backups
```

前者は実際の編集・保存を検証します。後者は通常起動の使い捨てプロファイルで平文バックアップの制約を再現します。
テスト後にプロファイルとデータを削除します。
CI は Rust・プロバイダテストを Linux / macOS / Windows に、エディタテストを Linux に設定しています。
この変更でリモートの CI は実行していません。ローカルで検証した環境は Linux x64 です。

## VSIX 作成

`vscode-extension/` で実行します。

```sh
npm run package
```

スクリプトが現在の OS・CPU 向けに Rust コアをビルドし、実行権限を付けて同梱した VSIX を作ります。
`bin/` に残った古いコアをそのまま使いません。開発依存、テスト、ソースコードは VSIX から除外します。
各 OS・CPU のパッケージは対応する環境で作成してください。
動的ライブラリや Nix の絶対パスを含む実行ファイルは別環境で動くとは限りません。
今回用意した Linux x64 の成果物は静的リンクのコアを含みます。他の配布環境はローカルでは未検証です。

## 開発用 CLI

```sh
./target/debug/venc init ./my-vault
./target/debug/venc unlock ./my-vault
```

`init` は新規ディレクトリを必要とし、二つのパスワードを確認入力します。
`unlock` はプロセス内で鍵を保持するセッションを開始します。
パスワードは端末に表示せず、コマンド引数や環境変数にも保存しません。
一行に一つの JSON 配列を入力します。

```json
["add", "./document.txt", "notes/document.txt"]
["list"]
["extract", "notes/document.txt", "./exported.txt"]
["passwd"]
["remove", "notes/document.txt"]
["lock"]
```

`add` はファイルを追加・置換します。**`extract` は明示的に平文を出力します**。既存の出力先を上書きしません。
`passwd` は現在の二つのパスワードを再認証し、同じマスターキーを新しいパスワードで保護します。ファイルは再暗号化しません。
`lock` と EOF はセッションを終了します。`add`、`extract`、`lock` は独立プロセスのコマンドではなく、解除セッション内の操作です。

拡張は `venc serve` に非公開の標準入出力パイプで接続します。CLI の平文出力や TCP サーバーは使いません。
IPC のフレーム・送信バッファ・待機リクエスト、KDF パラメータ、ファイルサイズには上限があります。
不正な応答やタイムアウトで接続を無効化します。

## 構成・保存形式

| 構成要素 | 役割 |
| --- | --- |
| `venc-crypto` | Argon2id、HKDF-SHA256、XChaCha20-Poly1305、鍵バッファの消去 |
| `venc-vault` | 暗号化メタデータ、ファイル・ディレクトリ操作、セッション、パスワード変更 |
| `venc-cli` | 対話 CLI と拡張用 IPC サーバー |
| `vscode-extension` | Vault の開閉 UI と仮想 FileSystemProvider |

Argon2id v19 で、独立した 16-byte salt を使い、64 MiB / 3 iterations / parallelism 1 の固定条件で順次二つの 32-byte 鍵を導出します。
HKDF-SHA256 で結合し、ランダムな 256-bit VMK を保護します。
VMK から別々の用途のメタデータ鍵とファイル鍵のラッピング鍵を導出します。
書き込みごとに新しいファイル鍵、オブジェクト ID、24-byte nonce を生成します。
AEAD の認証情報はバージョン、用途、Vault ID、オブジェクト ID を結び付けます。

```text
my-vault/
├── vault.json       # 公開パラメータと暗号化 VMK
├── metadata.enc     # 暗号化パス・ディレクトリ・時刻・ファイル鍵
├── .session.lock    # プロセス排他ロック
└── objects/
    └── <random-id>.enc
```

v1 のプロトタイプは byte 配列を JSON に保存します。ファイル・復号済みメタデータはそれぞれ最大 16 MiB です。
新コードは初期版のディレクトリ・時刻フィールドがないメタデータを読み込めます。更新後のメタデータは旧バイナリで読めません。フォーマットはまだ安定版ではありません。

更新は新しい暗号化オブジェクトを作成・同期した後、暗号化メタデータをアトミックに置換します。
パスワード変更は `vault.json` だけを置換します。
Unix ではディレクトリも同期し、ファイル 0600 / ディレクトリ 0700 を指定します。
コミット失敗時はセッションをロックします。電源断耐性は OS・ファイルシステムに依存し、網羅的な検証は未実施です。

置換・削除後のオブジェクトは障害対策のため残します。自動回収は未実装です。
初期化失敗時に新規ディレクトリが残ることがあります。完成した Vault として扱わず、自動的に再利用しないでください。

## 残る制約

未監査のプロトタイプです。復旧キー、チャンク暗号化、フォルダの再帰インポート、自動回収、ロールバック検知は未実装です。
片方のパスワードを失うと復旧できません。パスワード変更は同じ VMK を含む過去のバックアップからのアクセスを失効させません。
オブジェクト数・サイズ・時刻は隠しません。swap、クラッシュダンプ、他拡張、言語サーバー、Save As、エディタバックアップに平文が残り得ます。
オブジェクト内のシンボリックリンクを拒否しますが、悪意のあるローカルプロセスによるパス書き換え競合への完全な保護はありません。
信頼できる保存場所と独立した暗号化バックアップを使ってください。詳しい保証範囲と未解決項目は [SECURITY.md](SECURITY.md) に記載しています。

API 参考: [RustCrypto Argon2](https://docs.rs/argon2/0.5.3/argon2/)、[RustCrypto XChaCha20-Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/)。
