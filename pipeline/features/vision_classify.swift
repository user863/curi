// Apple Vision image classification (on device, no download): prints JSON {file: [{label, confidence}]}.
//   swiftc -O pipeline/features/vision_classify.swift -o /tmp/vision_classify && /tmp/vision_classify experiments/images > experiments/vision.json
import Foundation
import Vision

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let minConfidence: Float = 0.1
let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
var out: [String: [[String: Any]]] = [:]
for name in files where !name.hasPrefix(".") {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(url: dir.appendingPathComponent(name), options: [:])
    do {
        try handler.perform([request])
        let labels = (request.results ?? []).filter { $0.confidence >= minConfidence }.sorted { $0.confidence > $1.confidence }.prefix(8)
        out["images/\(name)"] = labels.map { ["label": $0.identifier, "confidence": (Double($0.confidence) * 1000).rounded() / 1000] }
    } catch {
        FileHandle.standardError.write("skip \(name): \(error)\n".data(using: .utf8)!)
    }
}
let json = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
print(String(data: json, encoding: .utf8)!)
