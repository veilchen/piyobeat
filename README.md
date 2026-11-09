# ぴよビート

ぴよログのテキスト出力をブラウザに貼ると、その場で曲にして、聴いて、共有できる静的Webアプリ。ぴよログの公式サービスではありません。

**正規のURL：https://veilchen.github.io/piyobeat/** このURL以外のページには記録を貼らないでください。送信しないことを保証できるのは、このリポジトリのコードから配信しているこのページだけです。

処理はすべてブラウザ内で完結します。バックエンドはなく、入力テキストは送信も保存もされません。

## 開発

```bash
npm install
npm run dev      # 開発サーバ（CSPなし）
npm test         # ユニットテスト
npm run build    # 型検査 + ビルド + dist の検査
npm run preview  # CSP入りの本番ビルドを確認
```

CSPは本番ビルドにだけ入ります。CSPや通信に関わる確認は `npm run preview` で行ってください。

## 実データ

`private/` に月別の `.txt` を置くと、`npm test` が日ごとの集計行と件数を照合します。結果は不一致の日数だけを表示し、日付や値は出しません。`private/` は `.gitignore` で除外しており、CIではスキップされます。

## 構成

| パス | 役割 |
|---|---|
| `src/parse/` | テキスト → `Event[]`（許可リスト方式）、睡眠区間の組み立て |
| `src/score/notes.ts` | `Event[]` → 段階化した `Note[]`。再生と共有リンクはどちらもこれを使う |
| `src/share/codec.ts` | `Note[]` ⇄ URL fragment |
| `src/audio/` | 音色、スケジューラ、WAV書き出し |
| `src/ui/score.ts` | 譜面のcanvas描画 |
| `scripts/check-dist.mjs` | 通信コードの混入とCSPの欠落を検出してビルドを止める |
| `docs/SPEC.md` | 仕様 |

## 公開

`.github/workflows/deploy.yml` が `main` へのpushでテストとビルドを実行し、GitHub Pagesへ配信します。ビルドは相対パスなので、他の静的ホストでもそのまま動きます。

## ライセンス

著作権は作者が保持しており、コードの再利用や、改変版・コピーの公開は許可していません（[LICENSE](LICENSE)）。プルリクエストは歓迎します（[CONTRIBUTING.md](CONTRIBUTING.md)）。
