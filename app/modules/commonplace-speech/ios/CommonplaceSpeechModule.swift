import ExpoModulesCore
import AVFoundation
import MLX
import KokoroSwift
import MLXUtilsLibrary

// Reads passages aloud with Kokoro-82M on the device. The model and voices are copied into the app bundle (Kokoro/) at build time.
// JS: read(id, voice, texts, gaps) speaks the chunks in order, gaps[i] ms of silence after chunk i; stop() cancels.
// Events "speech": { id, event: first | chunk | done | error, i, message }. "chunk" fires when chunk i has finished playing.
public final class CommonplaceSpeechModule: Module {
    private let work = DispatchQueue(label: "commonplace.speech", qos: .userInitiated)
    private var engine: KokoroTTS?
    private var voices: [String: MLXArray] = [:]
    private let audio = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var wired = false
    private let lock = NSLock()
    private let tape = Tape()
    private var current = 0 // bumped by every read and stop; work from an older value quits

    private var rate: Double { Double(KokoroTTS.Constants.samplingRate) }

    public func definition() -> ModuleDefinition {
        Name("CommonplaceSpeech")
        Events("speech")

        Function("read") { (id: Int, voice: String, texts: [String], gaps: [Double]) in
            let mine = self.begin()
            let chunks = Array(zip(texts, gaps))
            self.work.async { [weak self] in self?.read(id: id, session: mine, voice: voice, chunks: chunks) }
        }

        // Tape scrubbing (Tape.swift): tapeLoad resolves when the excerpt is decoded; hold/move/release follow the finger.
        AsyncFunction("tapeLoad") { (url: String, start: Double, end: Double, promise: Promise) in
            guard let link = URL(string: url) else { promise.reject("tape", "bad url"); return }
            Task {
                do { try await self.tape.load(url: link, start: start, end: end); promise.resolve(true) }
                catch { promise.reject("tape", error.localizedDescription) }
            }
        }
        Function("tapeHold") { (f: Double) in try self.tape.hold(f) }
        Function("tapeMove") { (f: Double) in self.tape.move(f) }
        Function("tapeRelease") { self.tape.release() }
        AsyncFunction("audioPeaks") { (url: String, start: Double, end: Double, n: Int, promise: Promise) in
            guard let link = URL(string: url) else { promise.reject("peaks", "bad url"); return }
            Task {
                do { promise.resolve(try await Tape.peaks(url: link, start: start, end: end, n: n)) }
                catch { promise.reject("peaks", error.localizedDescription) }
            }
        }
        Function("tapePeaks") { (n: Int) -> [Double] in self.tape.peaks(n) }
        Function("tapeUnload") { self.tape.unload() }

        Function("stop") {
            _ = self.begin()
            DispatchQueue.main.async { [weak self] in self?.player.stop() }
        }
    }

    private func begin() -> Int {
        lock.lock(); defer { lock.unlock() }
        current += 1
        return current
    }

    private func alive(_ session: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return session == current
    }

    private func send(_ id: Int, _ event: String, i: Int = 0, message: String = "") {
        sendEvent("speech", ["id": id, "event": event, "i": i, "message": message])
    }

    private func load() throws {
        if engine != nil { return }
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Kokoro"),
              case let model = dir.appendingPathComponent("kokoro-v1_0.safetensors"),
              case let npz = dir.appendingPathComponent("voices.npz"),
              FileManager.default.fileExists(atPath: model.path),
              let table = NpyzReader.read(fileFromPath: npz) else {
            throw NSError(domain: "speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Kokoro files missing from the app"])
        }
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
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
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
