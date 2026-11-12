import SwiftUI
import WebKit
import AVFoundation

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.userContentController.add(context.coordinator.captions, name: "captions")
        config.userContentController.add(context.coordinator.speech, name: "speech")
        // Console warnings and errors from the page go to the system log, so a problem on the phone can be read from the Mac.
        config.userContentController.add(context.coordinator.log, name: "log")
        config.userContentController.addUserScript(WKUserScript(source: """
            ['warn', 'error'].forEach(function (level) {
              var original = console[level];
              console[level] = function () {
                try { window.webkit.messageHandlers.log.postMessage(level + ': ' + Array.prototype.slice.call(arguments).join(' ')); } catch (e) {}
                original.apply(console, arguments);
              };
            });
            window.addEventListener('error', function (e) { try { window.webkit.messageHandlers.log.postMessage('error: ' + e.message + ' @' + e.filename + ':' + e.lineno); } catch (x) {} });
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        context.coordinator.captions.webView = view
        context.coordinator.speech.webView = view
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        view.scrollView.showsVerticalScrollIndicator = false
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 0.925, green: 0.925, blue: 0.925, alpha: 1)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isInspectable = true
        view.load(URLRequest(url: BundleSchemeHandler.start))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    // External links open in Safari; the app stays on its own scheme.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let captions = CaptionBridge()
        let speech = SpeechBridge()
        let log = PageLog()

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme == "http" || url.scheme == "https" else {
                return decisionHandler(.allow)
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }
    }
}
