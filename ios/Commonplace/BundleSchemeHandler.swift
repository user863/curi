import WebKit

// Serves the bundled web app from commonplace://app/..., so ES modules and fetch work offline.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "commonplace"
    static let start = URL(string: "commonplace://app/index.html")!

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "woff2": "font/woff2",
        "png": "image/png",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let root = Bundle.main.resourceURL?.standardizedFileURL else {
            return task.didFailWithError(URLError(.badURL))
        }
        let relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(relative).standardizedFileURL
        let data = file.path.hasPrefix(root.path) ? try? Data(contentsOf: file) : nil
        let headers = [
            "Content-Type": Self.mime[file.pathExtension] ?? "application/octet-stream",
            "Content-Length": "\(data?.count ?? 0)",
            "Cache-Control": "no-store",
        ]
        let response = HTTPURLResponse(url: url, statusCode: data == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data ?? Data())
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
