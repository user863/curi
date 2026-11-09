import Foundation

// AVAssetExportSession cannot cut a remote MP3, so the excerpt's bytes are fetched directly. MP3 frames are
// self-contained: a byte range starting at a frame boundary decodes on its own, so only the excerpt is downloaded.
enum Mp3Chunk {
    private static let bitrates1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    private static let bitrates2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    private static let rates = [3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]]
    private static let padding = 2.0 // seconds either side of the excerpt, for VBR drift

    struct Header { let bitrate: Int; let frameLength: Int }

    // Layer III frame header at `i`, or nil.
    static func header(_ d: [UInt8], at i: Int) -> Header? {
        guard i + 4 <= d.count, d[i] == 0xFF, d[i + 1] & 0xE0 == 0xE0 else { return nil }
        let version = Int((d[i + 1] >> 3) & 3), layer = Int((d[i + 1] >> 1) & 3)
        let brIndex = Int(d[i + 2] >> 4), srIndex = Int((d[i + 2] >> 2) & 3)
        guard version != 1, layer == 1, brIndex > 0, brIndex < 15, srIndex < 3, let sr = rates[version]?[srIndex] else { return nil }
        let kbps = (version == 3 ? bitrates1 : bitrates2)[brIndex]
        let pad = Int((d[i + 2] >> 1) & 1)
        return Header(bitrate: kbps * 1000, frameLength: (version == 3 ? 144 : 72) * kbps * 1000 / sr + pad)
    }

    // First position holding two consecutive valid frame headers.
    static func firstFrame(_ d: [UInt8], from: Int = 0) -> (index: Int, header: Header)? {
        var i = from
        while i + 4 < d.count {
            if let h = header(d, at: i), h.frameLength > 4, header(d, at: i + h.frameLength) != nil { return (i, h) }
            i += 1
        }
        return nil
    }

    private static func range(_ url: URL, _ from: Int, _ to: Int) async throws -> (Data, Int?) {
        var request = URLRequest(url: url)
        request.setValue("bytes=\(from)-\(to)", forHTTPHeaderField: "Range")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 206 else { throw URLError(.resourceUnavailable) }
        let total = http.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.flatMap { Int($0) }
        return (data, total)
    }

    // Writes the excerpt to a temporary .mp3. `offset` is the time in the file of the first byte written.
    static func fetch(_ url: URL, start: Double, end: Double) async -> (file: URL, offset: Double)? {
        do {
            let (head, total) = try await range(url, 0, 65535)
            let bytes = [UInt8](head)
            let tag = bytes.count > 10 && bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33
                ? 10 + (Int(bytes[6]) << 21 | Int(bytes[7]) << 14 | Int(bytes[8]) << 7 | Int(bytes[9])) : 0
            guard let total, tag < bytes.count - 8, let first = firstFrame(bytes, from: tag) else { return nil }
            let perSecond = Double(first.header.bitrate) / 8
            let from = max(first.index, first.index + Int((start - padding) * perSecond))
            let to = min(total - 1, first.index + Int((end + padding) * perSecond))
            guard to > from else { return nil }
            let (chunk, _) = try await range(url, from, to)
            let body = [UInt8](chunk)
            guard let sync = firstFrame(body) else { return nil }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp3")
            try Data(body[sync.index...]).write(to: file)
            return (file, Double(from + sync.index - first.index) / perSecond)
        } catch {
            NSLog("captions: mp3 fetch failed %@", error.localizedDescription)
            return nil
        }
    }
}
