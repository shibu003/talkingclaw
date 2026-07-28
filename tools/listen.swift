// terminal 用の音声入力。macOS 標準の音声認識(Speech.framework)でマイクを 1 発話ぶん聞き取り、
// 確定テキストを stdout に 1 行だけ出す。途中経過は stderr(CLI が「聞いてる…」表示に使う)。
// 使い方: claw-listen [最大秒数]   env: STT_LOCALE(既定 ja-JP)/ STT_SILENCE(無音で確定する秒)
import AVFoundation
import Foundation
import Speech

let env = ProcessInfo.processInfo.environment
let localeId = env["STT_LOCALE"] ?? "ja-JP"
let silenceSec = Double(env["STT_SILENCE"] ?? "1.3") ?? 1.3
let maxSec = Double(CommandLine.arguments.dropFirst().first ?? "30") ?? 30

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

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = false // 端末内モデルが無い言語でも動くようにする

let lock = NSLock()
var latest = ""
var lastUpdate = Date()
var finished = false

let task = recognizer.recognitionTask(with: request) { result, error in
    lock.lock()
    defer { lock.unlock() }
    if let result = result {
        let text = result.bestTranscription.formattedString
        if text != latest {
            latest = text
            lastUpdate = Date()
            FileHandle.standardError.write("\u{1B}[2K\r聞いてる… \(text)".data(using: .utf8)!)
        }
        if result.isFinal { finished = true }
    }
    if error != nil { finished = true }
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail("マイクが見つかりません(システム設定 → プライバシー → マイク で Terminal を許可)", 5) }
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
engine.prepare()
do { try engine.start() } catch { fail("マイクを開けませんでした: \(error.localizedDescription)", 5) }

let started = Date()
while true {
    usleep(100_000)
    lock.lock()
    let hasText = !latest.isEmpty
    let quietFor = Date().timeIntervalSince(lastUpdate)
    let done = finished
    lock.unlock()
    if done { break }
    if hasText && quietFor > silenceSec { break }            // 話し終わった
    if Date().timeIntervalSince(started) > maxSec { break }   // 保険
}

engine.stop()
input.removeTap(onBus: 0)
request.endAudio()
task.finish()
usleep(300_000) // 最後の確定を待つ

lock.lock()
let final = latest.trimmingCharacters(in: .whitespacesAndNewlines)
lock.unlock()
FileHandle.standardError.write("\u{1B}[2K\r".data(using: .utf8)!)
if final.isEmpty { exit(1) } // 何も聞き取れなかった
print(final)
exit(0)
