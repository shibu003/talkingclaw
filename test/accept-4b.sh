#!/bin/bash
# 4B 受入: 3 声(まお/コハク/まい)が解決でき、それぞれ合成できる
set -u
cd "$(dirname "$0")/.."
FAIL=0
ok() { echo "  ✅ $1"; }; ng() { echo "  ❌ $1"; FAIL=1; }
python3 - <<'PY' || FAIL=1
import json, urllib.request
E = 'http://127.0.0.1:10101'
speakers = json.load(urllib.request.urlopen(f'{E}/speakers', timeout=5))
ids = {}
for want, style in [('まお', 'あまあま'), ('コハク', 'ノーマル'), ('まい', 'ノーマル')]:
    sp = next((s for s in speakers if s['name'] == want), None)
    st = next((x for x in (sp or {}).get('styles', []) if x['name'] == style), None)
    assert st, f'{want}/{style} が見つからない'
    ids[want] = st['id']
print(f"  ✅ 3 声解決: {ids}")
assert len(set(ids.values())) == 3, '重複 id'
import urllib.parse
for name, sid in ids.items():
    q = urllib.request.urlopen(urllib.request.Request(
        f'{E}/audio_query?' + urllib.parse.urlencode({'text': 'こんにちは。', 'speaker': sid}), method='POST'), timeout=60).read()
    wav = urllib.request.urlopen(urllib.request.Request(
        f'{E}/synthesis?speaker={sid}', data=q, headers={'content-type': 'application/json'}, method='POST'), timeout=120).read()
    assert wav[:4] == b'RIFF', f'{name} 合成失敗'
    print(f"  ✅ {name} 合成 OK({len(wav)//1024}KB)")
PY
[ $FAIL = 0 ] && echo "4B 受入: ALL PASS" || echo "4B 受入: FAIL あり"
exit $FAIL
