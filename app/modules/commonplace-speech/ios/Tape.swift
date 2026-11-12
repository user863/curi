import AVFoundation
import os

// Tape-style scrubbing of one excerpt. The window [start, end] is decoded to mono PCM; the read head chases the finger,
// so speed (and pitch) follow the drag, backwards included, and it falls silent when the finger rests.
final class Tape {
    static let rate = 44_100.0
    private static let chase = 1 / (0.025 * rate) // gap closed in about 25 ms
    private static let grab = 1 - exp(-1 / (0.008 * rate)) // speed smoothing while held
    private static let free = 1 - exp(-1 / (0.040 * rate)) // and after letting go
    private static let limit = 24.0 // fastest tape speed, either way
    private static let wobble = 2 * Double.pi * 0.9 / rate
    private static let hp = exp(-2 * Double.pi * 90 / rate)
    private static let maxBytes = 25_000_000

    private var lock = os_unfair_lock()
    private var samples: [Float] = []
    private var pos = 0.0
    private var vel = 0.0
    private var target = 0.0
    private var held = false
    private var lp = 0.0, hpIn = 0.0, hpOut = 0.0, phase = 0.0 // tape voicing state
    private var generation = 0

    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode?
    private var stopper: DispatchWorkItem?

    var ready: Bool { os_unfair_lock_lock(&lock); defer { os_unfair_lock_unlock(&lock) }; return !samples.isEmpty }

    // Downloads (cached) and decodes the window. Throws when the file is too big, not decodable, or superseded.
    func load(url: URL, start: Double, end: Double) async throws {
        os_unfair_lock_lock(&lock); generation += 1; let mine = generation; samples = []; os_unfair_lock_unlock(&lock)
        let file = try await Self.fetch(url)
        let decoded = try await Self.decode(file, start: start, end: end)
        os_unfair_lock_lock(&lock); defer { os_unfair_lock_unlock(&lock) }
        guard mine == generation else { throw CancellationError() }
        samples = decoded; pos = 0; vel = 0; target = 0
    }

    // Loudness of the decoded excerpt in n buckets, 0.08...1 (the loudest bucket is 1). Empty before the excerpt is decoded.
    func peaks(_ n: Int) -> [Double] {
        os_unfair_lock_lock(&lock); let s = samples; os_unfair_lock_unlock(&lock)
        return Self.buckets(s, n)
    }

    // The same for any excerpt, independent of the one held for scrubbing: downloads the whole file (cached), decodes the window.
    static func peaks(url: URL, start: Double, end: Double, n: Int) async throws -> [Double] {
        let file = try await fetch(url)
        return buckets(try await decode(file, start: start, end: end), n)
    }

    private static func buckets(_ s: [Float], _ n: Int) -> [Double] {
        guard n > 0, s.count >= n else { return [] }
        let size = s.count / n
        let rms = (0..<n).map { i -> Double in
            let chunk = s[(i * size)..<((i + 1) * size)]
            return (chunk.reduce(0.0) { $0 + Double($1 * $1) } / Double(size)).squareRoot()
        }
        let top = max(rms.max() ?? 0, 1e-6)
        return rms.map { min(1, max(0.08, ($0 / top).squareRoot())) }
    }

    func unload() {
        os_unfair_lock_lock(&lock); generation += 1; samples = []; held = false; os_unfair_lock_unlock(&lock)
        engine.stop()
    }

    // Finger down at fraction f of the window: jump there.
    func hold(_ f: Double) throws {
        os_unfair_lock_lock(&lock)
        guard !samples.isEmpty else { os_unfair_lock_unlock(&lock); return }
        pos = min(max(f, 0), 1) * Double(samples.count - 1); target = pos; vel = 0; held = true
        os_unfair_lock_unlock(&lock)
        stopper?.cancel()
        try start()
    }

    func move(_ f: Double) {
        os_unfair_lock_lock(&lock)
        target = min(max(f, 0), 1) * Double(max(samples.count - 1, 0))
        os_unfair_lock_unlock(&lock)
    }

    func release() {
        os_unfair_lock_lock(&lock); held = false; os_unfair_lock_unlock(&lock)
        let item = DispatchWorkItem { [weak self] in self?.engine.pause() }
        stopper = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    private func start() throws {
        if source == nil {
            let format = AVAudioFormat(standardFormatWithSampleRate: Self.rate, channels: 1)!
            let node = AVAudioSourceNode(format: format) { [weak self] _, _, frames, list in
                self?.render(frames: Int(frames), list: list)
                return noErr
            }
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            source = node
        }
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback { try session.setCategory(.playback) }
        try session.setActive(true)
        if !engine.isRunning { try engine.start() }
    }

    private func render(frames: Int, list: UnsafeMutablePointer<AudioBufferList>) {
        let out = UnsafeMutableAudioBufferListPointer(list)
        guard let dst = out.first?.mData?.assumingMemoryBound(to: Float.self) else { return }
        guard os_unfair_lock_trylock(&lock) else { for i in 0..<frames { dst[i] = 0 }; return }
        defer { os_unfair_lock_unlock(&lock) }
        let n = samples.count
        guard n > 1 else { for i in 0..<frames { dst[i] = 0 }; return }
        let last = Double(n - 1)
        samples.withUnsafeBufferPointer { s in
            for i in 0..<frames {
                let want = held ? min(max((target - pos) * Self.chase, -Self.limit), Self.limit) : 0
                vel += (want - vel) * (held ? Self.grab : Self.free)
                phase += Self.wobble
                let speed = abs(vel)
                pos = min(max(pos + vel * (1 + 0.004 * sin(phase) + 0.0015 * sin(phase * 10)), 0), last)
                let k = Int(pos), frac = Float(pos - Double(k))
                let b = s[min(k + 1, n - 1)]
                var x = Double(s[k] + (b - s[k]) * frac)
                // slow tape is dull, fast tape bright; bass rolls off; the signal saturates softly; a little hiss rides the motion
                lp += (x - lp) * (1 - exp(-2 * .pi * (900 + 7000 * min(1, speed)) / Self.rate))
                hpOut = Self.hp * (hpOut + lp - hpIn); hpIn = lp
                x = tanh(1.7 * hpOut) / 1.7 + Double.random(in: -1...1) * 0.004 * min(1, speed * 2)
                dst[i] = Float(x * min(1, speed * 6))
            }
        }
    }

    // MARK: files

    private static func fetch(_ url: URL) async throws -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("tape", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = String(url.absoluteString.hashValue.magnitude, radix: 16) + "." + (url.pathExtension.isEmpty ? "audio" : url.pathExtension)
        let file = dir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        var head = URLRequest(url: url); head.httpMethod = "HEAD"
        let (_, meta) = try await URLSession.shared.data(for: head)
        if meta.expectedContentLength > maxBytes { throw NSError(domain: "tape", code: 1, userInfo: [NSLocalizedDescriptionKey: "file too large"]) }
        let (tmp, _) = try await URLSession.shared.download(from: url)
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: tmp, to: file)
        return file
    }

    private static func decode(_ file: URL, start: Double, end: Double) async throws -> [Float] {
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw NSError(domain: "tape", code: 2, userInfo: [NSLocalizedDescriptionKey: "no audio track"])
        }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: end, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
        ])
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? NSError(domain: "tape", code: 3) }
        var out: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var chunk = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
            chunk.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            out += chunk
        }
        if reader.status == .failed { throw reader.error ?? NSError(domain: "tape", code: 4) }
        guard out.count > Int(rate) / 10 else { throw NSError(domain: "tape", code: 5, userInfo: [NSLocalizedDescriptionKey: "empty"]) }
        return out
    }
}
