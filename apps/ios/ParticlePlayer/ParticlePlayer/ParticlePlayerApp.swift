import SwiftUI

/// The shell. Everything the piece is lives in the web player this app loads;
/// the app only supplies what an iPhone web page cannot have — the whole
/// screen, a display that never sleeps, and no browser between the piece and
/// the glass.
@main
struct ParticlePlayerApp: App {
    var body: some Scene {
        WindowGroup {
            PlayerScreen()
        }
    }
}
