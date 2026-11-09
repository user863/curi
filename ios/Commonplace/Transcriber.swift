import AVFoundation
import CryptoKit
import Speech

// Timed words for a media excerpt, from Apple's on-device speech recogniser. Audio never leaves the phone:
// only the excerpt's audio is exported (the system fetches just that range) and recognition is forced on-device.
struct CaptionJob {
    let id: String
    let url: URL
    let fallback: URL?
    let start: Double
    let end: Double
}

struct CaptionUpdate {
    enum Status: String { case working, done, none, unavailable }
    let id: String
    let status: Status
    let words: [[Any]] // [[start, duration, word]]
}

actor Transcriber {
    private var queue: [CaptionJob] = []
    private var running: (id: String, task: Task<Void, Never>)?
    private let emit: @Sendable (CaptionUpdate) -> Void

    init(emit: @escaping @Sendable (CaptionUpdate) -> Void) { self.emit = emit }

    // Replaces the queue. A job that is no longer wanted is cancelled.
    func want(_ jobs: [CaptionJob]) {
        queue = jobs
        if let running, !jobs.contains(where: { $0.id == running.id }) {
            running.task.cancel()
            self.running = nil
        }
        pump()
    }

    private func pump() {
        guard running == nil, let job = queue.first else { return }
        queue.removeFirst()
        let task = Task { [emit] in
            _ = await Self.transcribe(job, emit: emit)
            await self.finished(job.id)
        }
        running = (job.id, task)
    }

    private func finished(_ id: String) {
        if running?.id == id { running = nil }
        pump()
    }

    // MARK: work

    private static func cacheFile(_ job: CaptionJob) -> URL {
        let key = SHA256.hash(data: Data("\(job.id)|\(job.start)|\(job.end)".utf8)).map { String(format: "%02x", $0) }.joined()
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("captions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(key).json")
    }

    private static func authorised() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }

    // Audio of the excerpt as a local file, and the time in the source at which that file begins.
    private static func prepare(_ url: URL, start: Double, end: Double) async -> (file: URL, offset: Double)? {
        switch url.pathExtension.lowercased() {
        case "mp3": return await Mp3Chunk.fetch(url, start: start, end: end)
        case "mp4", "m4v", "mov", "m4a": return await Mp4Audio.fetch(url, start: start, end: end)
        default: return await exportAudio(url, start: start, end: end)
        }
    }

    private static func exportAudio(_ url: URL, start: Double, end: Double) async -> (file: URL, offset: Double)? {
        let asset = AVURLAsset(url: url)
        do {
            let total = try await asset.load(.duration).seconds
            guard total.isFinite, total > 1 else { NSLog("captions: bad duration %f", total); return nil }
            guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { NSLog("captions: no export session"); return nil }
            let from = min(start, max(0, total - 1))
            let to = min(end, total)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
            session.outputURL = out
            session.outputFileType = .m4a
            session.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600), end: CMTime(seconds: to, preferredTimescale: 600))
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in session.exportAsynchronously { c.resume() } }
            if session.status != .completed { NSLog("captions: export status %d %@", session.status.rawValue, String(describing: session.error)) }
            return session.status == .completed ? (out, from) : nil
        } catch {
            NSLog("captions: asset load failed %@", error.localizedDescription)
            return nil
        }
    }

    private static func words(_ result: SFSpeechRecognitionResult, offset: Double) -> [[Any]] {
        result.bestTranscription.segments.map { [round(($0.timestamp + offset) * 100) / 100, round($0.duration * 100) / 100, $0.substring] }
    }

    private static func transcribe(_ job: CaptionJob, emit: @escaping @Sendable (CaptionUpdate) -> Void) async -> CaptionUpdate.Status {
        let cache = cacheFile(job)
        if let data = try? Data(contentsOf: cache), let cached = try? JSONSerialization.jsonObject(with: data) as? [[Any]] {
            emit(CaptionUpdate(id: job.id, status: cached.isEmpty ? .none : .done, words: cached))
            return .done
        }
        guard await authorised(),
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            NSLog("captions %@: recogniser unavailable (on-device support: %d)", job.id, SFSpeechRecognizer(locale: Locale(identifier: "en-US"))?.supportsOnDeviceRecognition ?? false)
            emit(CaptionUpdate(id: job.id, status: .unavailable, words: []))
            return .unavailable
        }
        emit(CaptionUpdate(id: job.id, status: .working, words: []))
        var prepared = await prepare(job.url, start: job.start, end: job.end)
        if prepared == nil, let fallback = job.fallback { prepared = await prepare(fallback, start: job.start, end: job.end) }
        guard let (file, offset) = prepared, !Task.isCancelled else {
            NSLog("captions %@: audio export failed", job.id)
            emit(CaptionUpdate(id: job.id, status: .unavailable, words: []))
            return .unavailable
        }
        defer { try? FileManager.default.removeItem(at: file) }

        let request = SFSpeechURLRecognitionRequest(url: file)
        request.requiresOnDeviceRecognition = true // never the network
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        let final: [[Any]]? = await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<[[Any]]?, Never>) in
                var last: [[Any]] = []
                var settled = false
                recognizer.recognitionTask(with: request) { result, error in
                    guard !settled else { return }
                    if let result {
                        last = words(result, offset: offset)
                        if result.isFinal { settled = true; c.resume(returning: last) }
                        else { emit(CaptionUpdate(id: job.id, status: .working, words: [])) } // partial timestamps are not reliable
                    } else if let error {
                        NSLog("captions %@: recognition error %@", job.id, error.localizedDescription)
                        settled = true
                        c.resume(returning: last.isEmpty ? nil : last) // an error with nothing heard: no speech
                    }
                }
            }
        } onCancel: {}
        guard let final, !Task.isCancelled else {
            emit(CaptionUpdate(id: job.id, status: .none, words: []))
            return .none
        }
        if let data = try? JSONSerialization.data(withJSONObject: final) { try? data.write(to: cache) }
        emit(CaptionUpdate(id: job.id, status: final.isEmpty ? .none : .done, words: final))
        return .done
    }
}
