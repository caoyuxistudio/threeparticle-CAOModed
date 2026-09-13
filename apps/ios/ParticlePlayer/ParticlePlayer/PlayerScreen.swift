import SwiftUI

/// The one screen: the web player, edge to edge, over black.
struct PlayerScreen: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            PlayerWebView(url: PlayerSource.url)
                .ignoresSafeArea()
        }
        // The status bar and the Home indicator are the two things iOS kept
        // for itself on the web; here they go.
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            // An installation does not go to sleep.
            UIApplication.shared.isIdleTimerDisabled = true
        }
    }
}
