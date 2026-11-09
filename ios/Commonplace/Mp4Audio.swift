import AVFoundation

// AVAssetExportSession cannot cut a remote file, and downloading a film up to its excerpt would cost tens of MB.
// Instead: read the MP4's index (moov, near the start), work out where the excerpt's audio packets sit, fetch just
// those byte ranges into a sparse local copy, and decode the excerpt to a small PCM file.
enum Mp4Audio {
    private static let headBytes = 1_048_575
    private static let padding = 1.0 // seconds either side of the excerpt
    private static let parallel = 8
    private static let pieceBytes = 512 * 1024

    private static func get(_ url: URL, _ from: Int, _ to: Int) async throws -> (data: Data, total: Int?, final: URL) {
        var request = URLRequest(url: url)
        request.setValue("bytes=\(from)-\(to)", forHTTPHeaderField: "Range")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 206 else { throw URLError(.resourceUnavailable) }
        let total = http.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.flatMap { Int($0) }
        return (data, total, http.url ?? url) // the final URL skips the redirect on later requests
    }

    // Where the index (moov) ends, read from the top-level atoms in `head`; nil if it is not there.
    private static func indexEnd(_ head: Data) -> Int? {
        let bytes = [UInt8](head)
        var i = 0
        while i + 8 <= bytes.count {
            let size = bytes[i..<i + 4].reduce(0) { $0 << 8 | Int($1) }
            if String(decoding: bytes[i + 4..<i + 8], as: UTF8.self) == "moov" { return i + size }
            guard size >= 8 else { return nil }
            i += size
        }
        return nil
    }

    // Byte ranges of the audio chunks that cover the excerpt, read from the index alone.
    private static func chunks(_ index: URL, start: Double, end: Double, total: Int) async -> [ClosedRange<Int>]? {
        let asset = AVURLAsset(url: index)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
              let cursor = track.makeSampleCursor(presentationTimeStamp: CMTime(seconds: max(0, start - padding), preferredTimescale: 600)) else {
            NSLog("captions: mp4 has no readable audio track")
            return nil
        }
        var out: [ClosedRange<Int>] = []
        while cursor.presentationTimeStamp.seconds <= end + padding, out.count < 5000 {
            let r = cursor.currentChunkStorageRange
            let from = Int(r.offset), to = min(total - 1, Int(r.offset + r.length) - 1)
            if to >= from { out.append(from...to) }
            let step = cursor.currentChunkInfo.chunkSampleCount - cursor.currentSampleIndexInChunk
            guard step > 0, cursor.stepInDecodeOrder(byCount: step) == step else { break }
        }
        if out.isEmpty { NSLog("captions: mp4 excerpt has no audio chunks") }
        return out.isEmpty ? nil : out
    }

    // Local PCM file of the excerpt, and the time in the source at which it begins.
    static func fetch(_ url: URL, start: Double, end: Double) async -> (file: URL, offset: Double)? {
        let temp = FileManager.default.temporaryDirectory
        let index = temp.appendingPathComponent("\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: index) }
        do {
            var (head, total, final) = try await get(url, 0, headBytes)
            guard let total, let stop = indexEnd(head), stop <= total else { NSLog("captions: mp4 has no index near the start"); return nil }
            if stop > head.count { head.append(try await get(final, head.count, stop - 1).data) } // long films have a bigger index
            FileManager.default.createFile(atPath: index.path, contents: nil)
            let handle = try FileHandle(forWritingTo: index)
            try handle.truncate(atOffset: UInt64(total)) // sparse: only the fetched ranges take space
            try handle.seek(toOffset: 0) // truncate moves the file position to the end
            try handle.write(contentsOf: head)
            try handle.synchronize()
            NSLog("captions: mp4 index fetched (%d bytes)", head.count)
            guard let wanted = await chunks(index, start: start, end: end, total: total) else { try? handle.close(); return nil }
            // Audio sits between video frames in tiny pieces, so one request per piece would be thousands: fetch the
            // stretch of file that holds the excerpt in a few large parallel requests instead.
            let span = wanted.map(\.lowerBound).min()!...wanted.map(\.upperBound).max()!
            let pieces = stride(from: span.lowerBound, through: span.upperBound, by: pieceBytes).map { $0...min(span.upperBound, $0 + pieceBytes - 1) }
            NSLog("captions: mp4 fetching %d KB in %d requests", (span.upperBound - span.lowerBound) / 1024, pieces.count)
            for batch in stride(from: 0, to: pieces.count, by: parallel).map({ Array(pieces[$0..<min($0 + parallel, pieces.count)]) }) {
                let parts = try await withThrowingTaskGroup(of: (Int, Data).self) { group -> [(Int, Data)] in
                    batch.forEach { r in group.addTask { (r.lowerBound, try await get(final, r.lowerBound, r.upperBound).data) } }
                    return try await group.reduce(into: []) { $0.append($1) }
                }
                for (offset, data) in parts {
                    try handle.seek(toOffset: UInt64(offset))
                    try handle.write(contentsOf: data)
                }
            }
            try handle.close()
            NSLog("captions: mp4 audio fetched")
            return try decode(index, start: start, end: end, into: temp)
        } catch {
            NSLog("captions: mp4 audio failed %@", error.localizedDescription)
            return nil
        }
    }

    private static func decode(_ source: URL, start: Double, end: Double, into dir: URL) throws -> (file: URL, offset: Double) {
        let input = try AVAudioFile(forReading: source)
        let format = input.processingFormat
        input.framePosition = AVAudioFramePosition(start * format.sampleRate)
        let out = dir.appendingPathComponent("\(UUID().uuidString).caf")
        let output = try AVAudioFile(forWriting: out, settings: format.settings)
        var remaining = AVAudioFrameCount((end - start) * format.sampleRate)
        while remaining > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: min(remaining, 16384)) {
            try input.read(into: buffer)
            if buffer.frameLength == 0 { break }
            try output.write(from: buffer)
            remaining -= min(remaining, buffer.frameLength)
        }
        return (out, start)
    }
}
