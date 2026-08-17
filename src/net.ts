// PBI-036: 部屋を LAN に出すための小さな 1 部品。**既定は今までどおり localhost だけ**。
//
// ここが持つのは 2 つ:
//   1. **この機械の住所**（招待リンクに載せる LAN の IPv4）
//   2. **その住所で来た要求だけ通す判定**（DNS rebinding 対策を壊さずに LAN を許す）
//
// 判定は**列挙した住所との一致**でやる。「localhost 以外は拒否」を「何でも許可」に緩めると、
// 悪意ある名前で解決された要求（DNS rebinding）が通る —— 出す先を広げても、そこは緩めない。

import { networkInterfaces } from 'node:os';

/** この機械の LAN 上の IPv4（127.0.0.1 と内部・仮想 IF は除く） */
export function lanAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      // Docker / VPN / ブリッジは招待リンクの相手から見えないことが多いので後回しにする
      const virtual = /^(bridge|utun|awdl|llw|vmenet|docker|veth|tun|tap)/i.test(name);
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        if (virtual) out.push(ni.address);
        else out.unshift(ni.address);
      }
    }
  } catch { /* 取れなければ空 = localhost のまま案内する */ }
  return [...new Set(out)];
}

/**
 * 通してよい Host か。**列挙一致**（port は落として比べる）。
 * `host` が無い要求は拒否（DNS rebinding 対策。従来の規則をそのまま維持）。
 */
export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return allowed.some((a) => a.toLowerCase() === name);
}

/** 通してよい Origin か（存在する時だけ見る。curl や proxy の欠如は許す＝従来どおり） */
export function originAllowed(origin: string | undefined, allowed: string[], port: number): boolean {
  if (origin === undefined) return true;
  return allowed.some((a) => origin === `http://${a}:${port}` || origin === `https://${a}:${port}`);
}

/**
 * 招待リンクに載せる住所。LAN に出していない時は 127.0.0.1（＝同じ機械の中だけ）。
 * **出していないのに LAN の住所を渡すと、相手は必ず繋がらない**ので、そこは嘘をつかない。
 */
export function inviteHost(bind: string, lan: string[] = lanAddresses()): string {
  return bind === '0.0.0.0' && lan.length > 0 ? lan[0] : '127.0.0.1';
}
