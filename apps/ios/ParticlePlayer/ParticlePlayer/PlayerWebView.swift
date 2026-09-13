import SwiftUI
import WebKit

/// The web player in a WKWebView, configured as a display rather than a browser.
///
/// - Media plays inline and without a tap: the piece's colour source is a
///   looping video that has to start on its own.
/// - Nothing scrolls, bounces or zooms: the page is the picture.
/// - The gyroscope permission the page asks for is granted by the app, so the
///   parallax works the way it does in Safari.
/// - Inspectable, so Safari on a Mac can open Web Inspector on the phone.
struct PlayerWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.allowsAirPlayForMediaPlayback = false

        #if DEBUG
        // Debug builds forward the page's console and errors to the app's log,
        // so `log stream --predicate 'process == "Particle Player"'` on a Mac
        // shows what the page says — the simulator has no Web Inspector handy.
        configuration.userContentController.addUserScript(
            WKUserScript(source: Coordinator.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        configuration.userContentController.add(context.coordinator, name: "console")
        #endif

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.bouncesZoom = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isInspectable = true

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
        let url: URL

        init(url: URL) {
            self.url = url
        }

        static let consoleBridge = """
        (function () {
          var send = function (level, args) {
            try {
              var text = args.map(function (a) {
                if (typeof a === 'string') return a;
                if (a && a.stack) return String(a.stack);
                try { return JSON.stringify(a); } catch (e) { return String(a); }
              }).join(' ');
              window.webkit.messageHandlers.console.postMessage({ level: level, message: text });
            } catch (e) {}
          };
          ['log', 'info', 'warn', 'error'].forEach(function (level) {
            var original = console[level];
            console[level] = function () {
              var args = Array.prototype.slice.call(arguments);
              send(level, args);
              return original.apply(console, args);
            };
          });
          window.addEventListener('error', function (e) {
            send('error', [e.message, (e.filename || '') + ':' + e.lineno, e.error && e.error.stack]);
          });
          window.addEventListener('unhandledrejection', function (e) {
            send('error', ['unhandledrejection', e.reason && (e.reason.stack || e.reason)]);
          });
          send('info', ['bridge ready; navigator.gpu is ' + typeof navigator.gpu + '; ' + navigator.userAgent]);
        })();
        """

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            let level = body["level"] as? String ?? "log"
            let text = body["message"] as? String ?? ""
            NSLog("[web %@] %@", level, text)
        }

        // Once the page is up, ask it what it is running on, the way the HUD's
        // Copy report would.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            #if DEBUG
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                webView.evaluateJavaScript("(window.__perfHud && window.__perfHud.report) ? window.__perfHud.report() : 'no hud'") { result, error in
                    if let text = result as? String { NSLog("[web hud] %@", text) }
                    if let error { NSLog("[web hud] error %@", error.localizedDescription) }
                }
            }
            #endif
        }

        // The page asks for the gyroscope (DeviceOrientationEvent.requestPermission);
        // the app answers for the user, the way granting it in Safari would.
        func webView(
            _ webView: WKWebView,
            requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }

        // No page could be loaded (offline, a moved site): say so on black,
        // and try again on a tap, rather than showing a blank white view.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showUnreachable(in: webView, error: error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showUnreachable(in: webView, error: error)
        }

        private func showUnreachable(in webView: WKWebView, error: Error) {
            // A cancelled navigation is not a failure (a redirect, a reload).
            if (error as NSError).code == NSURLErrorCancelled { return }
            let message = (error as NSError).localizedDescription
                .replacingOccurrences(of: "<", with: "&lt;")
            let html = """
            <!doctype html><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
            <style>
              html,body{margin:0;height:100%;background:#000;color:#888;font:15px/1.5 -apple-system,sans-serif;
                display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
              b{color:#ddd;display:block;margin-bottom:8px}
            </style>
            <body onclick="location.replace('\(url.absoluteString)')">
              <div><b>The player could not be reached.</b>\(message)<br><br>Tap to try again.</div>
            </body>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }
    }
}
