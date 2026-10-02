// swift-tools-version:5.9
// Sesame: native macOS menu-bar front end for the `va` core (JSON-RPC over stdio, see ../docs/rpc.md).
// Build the .app with `macos/scripts/build-app.sh`; run unit tests with `swift test --package-path macos`.
import PackageDescription

let package = Package(
    name: "Sesame",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Sesame", targets: ["Sesame"]),
    ],
    targets: [
        // UI-free logic: RPC client, result mapping, paste auto-commit, hot key spec, config. Unit tested.
        .target(name: "SesameCore"),
        // AppKit + SwiftUI shell: status item, floating panel, settings window.
        .executableTarget(name: "Sesame", dependencies: ["SesameCore"]),
        .testTarget(name: "SesameCoreTests", dependencies: ["SesameCore"]),
    ]
)
