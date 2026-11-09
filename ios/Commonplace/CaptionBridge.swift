import WebKit

// JS asks for captions with postMessage({ want: [...] }); results come back through window.commonplaceCaptions.
final class CaptionBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private lazy var transcriber = Transcriber { [weak self] update in
        let payload: [String: Any] = ["id": update.id, "status": update.status.rawValue, "words": update.words]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self?.webView?.evaluateJavaScript("window.commonplaceCaptions(\(json))") }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let list = body["want"] as? [[String: Any]] else { return }
        let jobs = list.compactMap { item -> CaptionJob? in
            guard let id = item["id"] as? String, let url = (item["url"] as? String).flatMap(URL.init(string:)),
                  let start = item["start"] as? Double, let end = item["end"] as? Double else { return nil }
            let fallback = (item["fallback"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
            return CaptionJob(id: id, url: url, fallback: fallback, start: start, end: end)
        }
        Task { await transcriber.want(jobs) }
    }
}
