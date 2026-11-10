import WebKit

// Receives the page's console warnings and errors.
final class PageLog: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("page %@", String(describing: message.body))
    }
}
