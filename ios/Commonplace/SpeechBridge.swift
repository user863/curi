import WebKit
import AVFoundation
import MLX
import KokoroSwift
import MLXUtilsLibrary

// Reads passages aloud with Kokoro-82M, on the device. The model and voices are in the app bundle (ios/Kokoro).
// JS posts { op: "read", id, voice, chunks: [{ t: text, gap: milliseconds of silence after it }] } or { op: "stop" };
// events come back through window.commonplaceSpeech({ id, event: "first" | "chunk" | "done" | "error", i, message }).
// "chunk" fires when chunk i has finished playing, so JS knows where to resume after a pause.
final class SpeechBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    private let work = DispatchQueue(label: "commonplace.speech", qos: .userInitiated)
    private var engine: KokoroTTS?
    private var voices: [String: MLXArray] = [:]
    private let audio = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var wired = false
    private let lock = NSLock()
    private var current = 0 // bumped by every read and stop; work from an older value quits

    private var rate: Double { Double(KokoroTTS.Constants.samplingRate) }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        if op == "stop" { return stop() }
        guard op == "read", let id = body["id"] as? Int, let list = body["chunks"] as? [[String: Any]] else { return }
        let chunks = list.compactMap { item -> (String, Double)? in
            guard let text = item["t"] as? String else { return nil }
            return (text, (item["gap"] as? Double) ?? 0)
        }
        let voice = (body["voice"] as? String) ?? "af_heart"
        let mine = begin()
        work.async { [weak self] in self?.read(id: id, session: mine, voice: voice, chunks: chunks) }
    }

    private func begin() -> Int {
        lock.lock(); defer { lock.unlock() }
        current += 1
        return current
    }

    private func stop() {
        _ = begin()
        DispatchQueue.main.async { [weak self] in self?.player.stop() }
    }

    private func alive(_ session: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return session == current
    }

    private func send(_ id: Int, _ event: String, i: Int = 0, message: String = "") {
        let payload: [String: Any] = ["id": id, "event": event, "i": i, "message": message]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in self?.webView?.evaluateJavaScript("window.commonplaceSpeech && window.commonplaceSpeech(\(json))") }
    }

    private func load() throws {
        if engine != nil { return }
        guard let model = Bundle.main.url(forResource: "kokoro-v1_0", withExtension: "safetensors"),
              let npz = Bundle.main.url(forResource: "voices", withExtension: "npz"),
              let table = NpyzReader.read(fileFromPath: npz) else { throw NSError(domain: "speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Kokoro files missing from the app"]) }
        // MLX keeps freed buffers for reuse, and by default that cache may grow without limit; on a phone that ends in the system
        // killing the app. Keep it small and give the buffers back after every chunk.
        Memory.cacheLimit = 24 * 1024 * 1024
        engine = KokoroTTS(modelPath: model)
        voices = table
    }

    private func wire() throws {
        if !wired {
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            audio.attach(player)
            audio.connect(player, to: audio.mainMixerNode, format: format)
            wired = true
        }
        if !audio.isRunning { try audio.start() }
    }

    private func buffer(_ samples: [Float], gap: Double) -> AVAudioPCMBuffer? {
        let silence = Int(rate * gap / 1000)
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count + silence)) else { return nil }
        buf.frameLength = buf.frameCapacity
        let dst = buf.floatChannelData![0]
        samples.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { dst.update(from: base, count: samples.count) }
        }
        (dst + samples.count).update(repeating: 0, count: silence)
        return buf
    }

    private func read(id: Int, session: Int, voice: String, chunks: [(String, Double)]) {
        do {
            try load()
            try wire()
            guard let style = voices[voice + ".npy"], let engine else { throw NSError(domain: "speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "voice \(voice) not found"]) }
            var started = false
            for (i, chunk) in chunks.enumerated() {
                guard alive(session) else { return }
                let (samples, _) = try engine.generateAudio(voice: style, language: voice.hasPrefix("a") ? .enUS : .enGB, text: chunk.0)
                Memory.clearCache()
                guard alive(session), let buf = buffer(samples, gap: chunk.1) else { return }
                let last = i == chunks.count - 1
                player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    guard let self, self.alive(session) else { return }
                    self.send(id, last ? "done" : "chunk", i: i)
                }
                if !started {
                    started = true
                    DispatchQueue.main.async { [weak self] in self?.player.play() }
                    send(id, "first")
                }
            }
        } catch {
            if alive(session) { send(id, "error", message: error.localizedDescription) }
        }
    }
}
