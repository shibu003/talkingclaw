// terminal 用の音声入力。macOS 標準の音声認識(Speech.framework)でマイクを 1 発話ぶん聞き取り、
// 確定テキストを stdout に 1 行だけ出す。途中経過は stderr(CLI が「聞いてる…」表示に使う)。
// 使い方: claw-listen [最大秒数]   env: STT_LOCALE(既定 ja-JP)/ STT_SILENCE(無音で確定する秒)
import AVFoundation
import Foundation
import Speech

let env = ProcessInfo.processInfo.environment
let localeId = env["STT_LOCALE"] ?? "ja-JP"
let silenceSec = Double(env["STT_SILENCE"] ?? "1.3") ?? 1.3

// --continuous: 1 発話で終了せず、聞き続ける。stdout の各行に接頭辞が付く:
//   PARTIAL <text>  途中経過。「人間が話し始めた」の合図で、割り込み(barge-in)の起点になる
//   FINAL <text>    確定した 1 発話
// 接頭辞なしの旧モード(1 発話 → 1 行 → exit)は後方互換のため残す。
let args = CommandLine.arguments.dropFirst()
let continuous = args.contains("--continuous")
let maxSec = Double(args.first(where: { !$0.hasPrefix("--") }) ?? "30") ?? 30

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("claw-listen: \(message)\n".data(using: .utf8)!)
    exit(code)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fail("この言語の音声認識が使えません: \(localeId)", 2)
}

// 認可(初回は macOS がダイアログを出す。Terminal に「音声認識」と「マイク」の許可が要る)
let authSem = DispatchSemaphore(value: 0)
var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { status in
    authStatus = status
    authSem.signal()
}
authSem.wait()
guard authStatus == .authorized else {
    fail("音声認識が許可されていません(システム設定 → プライバシーとセキュリティ → 音声認識 で Terminal を許可)", 3)
}
guard recognizer.isAvailable else { fail("音声認識が今は使えません(ネットワーク or 言語データ)", 4) }

// 認識器の状態を出す。ここが分からないと「音は来ているのに認識が動かない」で詰まる。
// onDevice: 端末内モデルの有無。ON_DEVICE=1 でサーバ経由をやめて端末内に固定できる
let wantOnDevice = env["ON_DEVICE"] == "1"
FileHandle.standardError.write(
    "claw-listen: locale=\(localeId) available=\(recognizer.isAvailable) onDeviceSupported=\(recognizer.supportsOnDeviceRecognition) useOnDevice=\(wantOnDevice)\n"
        .data(using: .utf8)!)

let lock = NSLock()
var latest = ""
var lastUpdate = Date()
var finished = false
var partialSent = false // この発話で PARTIAL を出したか(1 発話につき 1 回だけ)
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?

// 1 回ぶんの認識セッションを張る。マイク(engine)は開いたままで、ここだけを差し替える。
// こうしないと発話ごとにマイクが落ちて、その間の声が失われる。
func startSession() {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = wantOnDevice // ON_DEVICE=1 で端末内に固定(サーバ経由が通らない環境の逃げ道)

    lock.lock()
    latest = ""
    lastUpdate = Date()
    finished = false
    partialSent = false
    request = req
    lock.unlock()

    task = recognizer.recognitionTask(with: req) { result, error in
        var firstPartial: String? = nil
        lock.lock()
        if let result = result {
            let text = result.bestTranscription.formattedString
            if text != latest {
                latest = text
                lastUpdate = Date()
                FileHandle.standardError.write("\u{1B}[2K\r聞いてる… \(text)".data(using: .utf8)!)
                // 連続モードでは「喋り始めた」を即座に外へ知らせる = 割り込みの起点
                if continuous && !partialSent && !text.isEmpty {
                    partialSent = true
                    firstPartial = text
                }
            }
            if result.isFinal { finished = true }
        }
        // エラーを握りつぶすと「即座に終了するが理由が分からない」状態になる。原則は出す。
        // ただし「No speech detected」だけは違う — これは異常ではなく「まだ喋っていない」。
        // 連続モードでは無音のたびに出るので、そのまま表示すると本物のエラーが埋もれる
        if let error = error {
            let ns = error as NSError
            let isSilence = ns.localizedDescription.contains("No speech detected")
            if !isSilence {
                FileHandle.standardError.write(
                    "claw-listen: 認識が止まりました: \(error.localizedDescription)\n".data(using: .utf8)!)
            }
            finished = true
        }
        lock.unlock()
        if let p = firstPartial { emit("PARTIAL \(p)") } // lock の外で書く
    }
}

startSession()

let engine = AVAudioEngine()
let input = engine.inputNode

// エコーキャンセル。これが無いと、AI が喋っている最中にマイクを開けない(自分の声を認識してしまう)。
// 割り込み(barge-in)は「再生中もマイクが生きている」ことが前提なので、ここが土台になる。
// ただし有効にすると入力フォーマットが変わり、音声認識が発火しなくなる環境がある。
// NO_EC=1 で切って切り分けられるようにしてある。
if env["NO_EC"] != "1" {
    do {
        try input.setVoiceProcessingEnabled(true)
    } catch {
        FileHandle.standardError.write(
            "claw-listen: エコーキャンセルを有効にできませんでした(再生中の割り込みは不安定になります): \(error.localizedDescription)\n"
                .data(using: .utf8)!)
    }
}

let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail("マイクが見つかりません(システム設定 → プライバシー → マイク で Terminal を許可)", 5) }
// 入力レベルの実測。macOS はマイク権限が拒否されていると **エラーではなく無音を流す**ので、
// これが無いと「マイクは開けたのに何も聞こえない」で原因が特定できない。
// LEVEL=1 の時だけ 1 秒ごとに peak を出す(常時出すと認識表示を潰す)。
let showLevel = env["LEVEL"] == "1"
var levelPeak: Float = 0
var levelAt = Date()
// 「喋り終わった」の判定は認識テキストの更新ではなく **音そのもの** を見る。
// テキストの更新間隔で判定すると、認識が一瞬詰まっただけで発話が切られ、
// 「Can you hear me」が「You」「Can you」「Can you hear me」の 3 発話に割れる(実測)。
// 割れた数だけ AI が応答するので、体感の遅さの主因にもなっていた。
// STT_GATE: 声とみなす音量の下限。マイクと環境で変わるので調整できるようにしてある
//           (LEVEL=1 で実測値が見える)
let soundGate = Float(env["STT_GATE"] ?? "0.02") ?? 0.02
var lastSoundAt = Date()

// ★ 認識に渡す形は 1ch に落とす。内蔵マイクはマイクアレイで **5ch** を返すことがあり、
// SFSpeechAudioBufferRecognitionRequest に多チャンネルのバッファを渡すと
// **エラーも結果も返さず沈黙する**(これが「音は届くのに認識が動かない」の正体だった)。
let monoFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
let _unusedConverterRemoved = false
let converter: AVAudioConverter? = {
    guard let mono = monoFormat, format.channelCount != 1 else { return nil }
    return AVAudioConverter(from: format, to: mono)
}()
if converter != nil {
    FileHandle.standardError.write(
        "claw-listen: \(format.channelCount)ch → 1ch に変換して認識に渡します\n".data(using: .utf8)!)
}

input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    // 音量は毎回測る(無音判定に使うので LEVEL=1 の時だけでは足りない)。
    // 4 サンプルおきで十分 — ピークの検出に全サンプルは要らない
    var peak: Float = 0
    if let ch = buffer.floatChannelData?[0] {
        for i in stride(from: 0, to: Int(buffer.frameLength), by: 4) { peak = max(peak, abs(ch[i])) }
    }
    lock.lock()
    if peak > soundGate { lastSoundAt = Date() }
    lock.unlock()

    if showLevel {
        lock.lock()
        levelPeak = max(levelPeak, peak)
        let elapsed = Date().timeIntervalSince(levelAt)
        let show = elapsed >= 1.0
        let p = levelPeak
        if show { levelPeak = 0; levelAt = Date() }
        lock.unlock()
        if show {
            let bars = String(repeating: "#", count: min(40, Int(p * 200)))
            FileHandle.standardError.write(
                "  level \(String(format: "%.4f", p)) \(bars) gate=\(String(format: "%.3f", soundGate))\n"
                    .data(using: .utf8)!)
        }
    }
    lock.lock()
    let req = request
    lock.unlock()
    guard let req = req else { return }

    // サンプルレートは同じなので変換は要らない。1ch 目をそのままコピーするだけ。
    // AVAudioConverter を使うと frameLength が設定されず、空のバッファを渡して
    // 認識が沈黙する(実測)。ここは素朴なコピーが正しい。
    guard let mono = monoFormat, format.channelCount != 1 else {
        req.append(buffer) // 既に 1ch ならそのまま
        return
    }
    let frames = buffer.frameLength
    guard frames > 0,
          let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: frames),
          let src = buffer.floatChannelData?[0],
          let dst = out.floatChannelData?[0]
    else { return }
    out.frameLength = frames // ← これを設定しないと「長さ 0 の音声」になる
    memcpy(dst, src, Int(frames) * MemoryLayout<Float>.size)
    req.append(out)
}
engine.prepare()
do { try engine.start() } catch { fail("マイクを開けませんでした: \(error.localizedDescription)", 5) }
// フォーマットを出す。認識に渡すバッファの形が合っていないと、エラーも結果も返らず
// 沈黙するだけになるため、ここが見えないと切り分けられない
FileHandle.standardError.write(
    "claw-listen: マイク開始 \(Int(format.sampleRate))Hz ch=\(format.channelCount) fmt=\(format.commonFormat.rawValue) interleaved=\(format.isInterleaved)。話しかけてください…\n"
        .data(using: .utf8)!)

// 1 発話ぶん待つ。戻り値は確定テキスト(空 = 何も聞き取れなかった)
func awaitUtterance(deadline: Double) -> String {
    let started = Date()
    // 前の発話の「最後に音があった時刻」を持ち越すと、次の発話が始まる前に
    // 無音時間を満たしてしまう。1 発話ごとに測り直す
    lock.lock(); lastSoundAt = Date(); lock.unlock()
    while true {
        // usleep でスレッドを寝かせてはいけない。SFSpeechRecognizer のコールバックは
        // メインキューにディスパッチされるので、RunLoop を回さないと認識結果が
        // 一度も配送されない(音は installTap で届いているのに「聞いてる…」が出ない状態になる)。
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        lock.lock()
        let hasText = !latest.isEmpty
        // 静かになったかは音で測る。認識テキストの更新(lastUpdate)ではない
        let quietFor = Date().timeIntervalSince(lastSoundAt)
        let done = finished
        lock.unlock()
        if done { break }
        if hasText && quietFor > silenceSec { break }          // 話し終わった
        if Date().timeIntervalSince(started) > deadline { break } // 保険
    }
    lock.lock()
    let req = request
    request = nil
    lock.unlock()
    req?.endAudio()
    task?.finish()
    RunLoop.current.run(until: Date().addingTimeInterval(0.4)) // 最後の確定を待つ(ここも RunLoop で回す)
    lock.lock()
    let text = latest.trimmingCharacters(in: .whitespacesAndNewlines)
    lock.unlock()
    FileHandle.standardError.write("\u{1B}[2K\r".data(using: .utf8)!)
    return text
}

func shutdown() -> Never {
    engine.stop()
    input.removeTap(onBus: 0)
    exit(0)
}

if continuous {
    // 聞き続ける。マイクは開いたまま、認識セッションだけ張り直す。
    // SIGINT/SIGTERM で抜ける(親が落ちれば道連れになる)
    signal(SIGINT) { _ in exit(0) }
    signal(SIGTERM) { _ in exit(0) }
    while true {
        let text = awaitUtterance(deadline: maxSec)
        if !text.isEmpty { emit("FINAL \(text)") }
        startSession() // 次の発話へ
    }
}

// 旧モード: 1 発話で終了(後方互換)
let final = awaitUtterance(deadline: maxSec)
engine.stop()
input.removeTap(onBus: 0)
if final.isEmpty { exit(1) } // 何も聞き取れなかった
print(final)
shutdown()
