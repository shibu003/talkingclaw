# 伝言ページ公開の設置手順(ユーザーと一緒にやる)

PBI-003 の設置手順書。cloudflared named tunnel + Cloudflare Access で
`https://<MEMO_HOST>/memo` だけを外網に出す。**👤 の付いた手順はユーザーの操作が必須**
(ブラウザログイン・ダッシュボード操作・sudo・スマホ)。Claude は同席して支援するが、
cloudflared login・DNS 変更・launchctl は勝手に実行しない。

前提(実測 2026-08-06): cloudflared 2026.7.1 (`/usr/local/bin/cloudflared`)、
node v26.3.0 (`/usr/local/bin/node`)、`~/.cloudflared` は未作成(= login 未実施)。

コマンドの出典: [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) /
[Configuration file](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/local-management/configuration-file/)(2026-08-06 参照)

---

## 1. 👤 Cloudflare にログイン

```sh
cloudflared tunnel login
```

ブラウザが開くので **ユーザーが** Cloudflare アカウントでログインし、使う zone(ドメイン)を
選ぶ。成功すると `~/.cloudflared/cert.pem` ができる。
**cert.pem・この後できる credential json は絶対に repo にコピーしない**(AC-6)。

## 2. named tunnel を作る

```sh
cloudflared tunnel create talkingclaw-memo
```

出力される **Tunnel UUID を控える**。`~/.cloudflared/<UUID>.json`(credential)ができる。

## 3. 👤 hostname を決めて config を置く

hostname はここで **ユーザーと相談して決める**(例: `memo.example.com`。zone は手順 1 で
選んだドメイン)。決めたら:

```sh
cp deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml
```

`~/.cloudflared/config.yml` の `<TUNNEL_UUID>`(2 箇所)と `<MEMO_HOST>` を実値に書き換える。
ingress は `/memo` と `/memo/api/*` だけを `localhost:3300` に流し、それ以外は 404(AC-2 の土台)。

検算(設定ファイルの構文チェック):

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://<MEMO_HOST>/memo
cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://<MEMO_HOST>/events
```

`/memo` は `http://localhost:3300`、`/events` は `http_status:404` に当たれば正しい。

## 4. 👤 DNS route を張る

```sh
cloudflared tunnel route dns talkingclaw-memo <MEMO_HOST>
```

zone の DNS に CNAME が追加される(**DNS 変更なのでユーザー同席で実行**)。

## 5. 👤 Cloudflare Access アプリを作る(ダッシュボード操作)

[Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) → **Access** → **Applications** →
**Add an application** → **Self-hosted**:

- **Application domain**: `<MEMO_HOST>` を **hostname 全体で**(path は空欄のまま。
  `/memo` に絞らない — 未認証者には 404 すら見せない設計)
- **Identity provider**: Google ログインを有効化(未設定なら Settings → Authentication →
  Login methods で Google を追加)
- **Policy**: Action = Allow、Include = **Emails** で許可するメールアドレスを列挙
  (最低限ユーザー本人の Gmail。**許可メール一覧は repo に書かない** — AC-6)
- **Session duration**: まず既定で作り、スマホでの再ログイン頻度を見て調整
  (PBI-003 不確実性表の検証項目)

## 6. 👤 plist を設置する(sudo 必要)

**先に確認**: 手動起動の部屋(`npm run web`)が動いているなら **ユーザーが止める**
(LaunchDaemon と port 3300 が衝突するため)。Claude は部屋のプロセスに触らない。

```sh
mkdir -p ~/Library/Logs/talkingclaw
plutil -lint deploy/com.talkingclaw.room.plist deploy/com.talkingclaw.cloudflared.plist
sudo cp deploy/com.talkingclaw.room.plist deploy/com.talkingclaw.cloudflared.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.talkingclaw.*.plist
sudo chmod 644 /Library/LaunchDaemons/com.talkingclaw.*.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.talkingclaw.room.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.talkingclaw.cloudflared.plist
```

状態確認:

```sh
launchctl print system/com.talkingclaw.room | grep -E "state|pid"
launchctl print system/com.talkingclaw.cloudflared | grep -E "state|pid"
tail -20 ~/Library/Logs/talkingclaw/room.log ~/Library/Logs/talkingclaw/cloudflared.log
```

メモ: 部屋の plist の `MEMO_PUBLIC_ORIGIN` はコメントアウトしてある。room 側 diff
(memo 限定 origin 許可)が入ったらコメントを外して hostname を書き、
`sudo launchctl kickstart -k system/com.talkingclaw.room` で反映する。

## 7. 検証(AC の curl 一式)

以下 `<MEMO_HOST>` は手順 3 で決めた hostname。

### AC-1: unauth-opaque(未認証には Access だけが見える)

```sh
curl -sSI "https://<MEMO_HOST>/memo" | head -20
curl -sS "https://<MEMO_HOST>/memo" | head -40
```

期待: Access の login へのリダイレクト(302 → `cloudflareaccess.com`)か Access のページ
**のみ**。部屋の本文・token・bootId が一切含まれないこと。加えてシークレットウィンドウで
開き、Access のログイン画面だけが出ることを目視。

### AC-2: path-lockdown(認証済みでも memo 以外は 404)

👤 まずブラウザで `https://<MEMO_HOST>/memo` を開いて Google ログインし、
DevTools → Application → Cookies から `CF_Authorization` の値をコピーする(この値は
認証情報なのでファイルに保存しない)。

```sh
JWT='<コピーした CF_Authorization>'
for p in / /events /participants /files/x /uploads/x /room.js /index.html; do
  curl -s -o /dev/null -w "%{http_code}  $p\n" -H "cookie: CF_Authorization=$JWT" "https://<MEMO_HOST>$p"
done
curl -s -o /dev/null -w "%{http_code}  /memo\n"         -H "cookie: CF_Authorization=$JWT" "https://<MEMO_HOST>/memo"
curl -s -o /dev/null -w "%{http_code}  /memo/api/log\n" -H "cookie: CF_Authorization=$JWT" "https://<MEMO_HOST>/memo/api/log?after=0"
```

期待: 前半は **全部 404**、`/memo` と `/memo/api/log` は **200**。

### AC-3: host-origin-reject(偽 Host/Origin の POST は 403)

**room 側 diff(memo 限定 origin 許可)実装後に有効。実施は隔離部屋で**(本 PBI の
テスト設計どおり。本番部屋には打たない):

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:<隔離部屋PORT>/memo/api/say" \
  -H "content-type: application/json" -H "Origin: https://evil.example" \
  -d '{"text":"ac3-test","clientMessageId":"ac3-1"}'
```

期待: 403。かつ user_speech・永続ログ・metrics が増えないこと。

### AC-4: 👤 ext-e2e(実機・モバイル回線)

スマホを Wi-Fi off(モバイル回線)にして `https://<MEMO_HOST>/memo` を開く → Google
ログイン → 伝言を送信 → work channel に 1 件だけ届き、同じ clientMessageId の返答・
最終報告がページで読めること。

### AC-5: launchd-revive(自動復帰)

```sh
sudo launchctl kickstart -k system/com.talkingclaw.cloudflared
sleep 15
curl -sS -o /dev/null -w "%{http_code}\n" "https://<MEMO_HOST>/memo"
```

期待: 200(認証済み cookie 付き)または 302(未認証)が返る = tunnel が自動復帰した。
実 PC reboot 後の確認は別途行う(PBI の AC-5 注記どおり)。

### AC-6: secret-scan

```sh
git diff --staged | grep -nEi "cloudflared|CF_Authorization|BEGIN (RSA |EC )?PRIVATE|TunnelSecret|AccountTag|@gmail|@googlemail" || echo "clean"
git status --short   # ~/.cloudflared 由来のファイル・.env* が staged に無いことを目視
```

期待: `clean`。credential json・cert.pem・許可メール一覧・実 hostname 入り config が
repo に入っていないこと。

### AC-7: adapter-channel-fix

room 側の submit adapter 実装後に、隔離部屋で `activeChannel=chat` の状態から memo 送信 →
event が `channel=work` にのみ入ることを確認(自動テスト。この手順書の範囲外)。

---

## 撤去手順(必要になったら)

```sh
sudo launchctl bootout system/com.talkingclaw.cloudflared
sudo launchctl bootout system/com.talkingclaw.room
sudo rm /Library/LaunchDaemons/com.talkingclaw.cloudflared.plist /Library/LaunchDaemons/com.talkingclaw.room.plist
```

Access アプリと DNS route はダッシュボードから削除。
