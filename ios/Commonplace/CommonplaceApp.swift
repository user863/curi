import SwiftUI

@main
struct CommonplaceApp: App {
    var body: some Scene {
        WindowGroup {
            WebView()
                .ignoresSafeArea()
                .background(Color(red: 0.925, green: 0.925, blue: 0.925))
                .statusBarHidden(true)
        }
    }
}
