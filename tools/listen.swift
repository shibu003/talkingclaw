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
    req.requiresOnDeviceRecognition = false // 端末内モデルが無い言語でも動くようにする

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
        if error != nil { finished = true }
        lock.unlock()
        if let p = firstPartial { emit("PARTIAL \(p)") } // lock の外で書く
    }
}

startSession()

let engine = AVAudioEngine()
let input = engine.inputNode

// エコーキャンセル。これが無いと、AI が喋っている最中にマイクを開けない(自分の声を認識してしまう)。
// 割り込み(barge-in)は「再生中もマイクが生きている」ことが前提なので、ここが土台になる。
// 失敗しても致命的ではないので警告だけ出して続ける(録音自体は可能)。
do {
    try input.setVoiceProcessingEnabled(true)
} catch {
    FileHandle.standardError.write(
        "claw-listen: エコーキャンセルを有効にできませんでした(再生中の割り込みは不安定になります): \(error.localizedDescription)\n"
            .data(using: .utf8)!)
}

let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail("マイクが見つかりません(システム設定 → プライバシー → マイク で Terminal を許可)", 5) }
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    lock.lock()
    let req = request
    lock.unlock()
    req?.append(buffer)
}
engine.prepare()
do { try engine.start() } catch { fail("マイクを開けませんでした: \(error.localizedDescription)", 5) }

// 1 発話ぶん待つ。戻り値は確定テキスト(空 = 何も聞き取れなかった)
func awaitUtterance(deadline: Double) -> String {
    let started = Date()
    while true {
        usleep(100_000)
        lock.lock()
        let hasText = !latest.isEmpty
        let quietFor = Date().timeIntervalSince(lastUpdate)
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
    usleep(300_000) // 最後の確定を待つ
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
