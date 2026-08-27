// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RuntimeRaidersAgent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "RuntimeRaidersCore", targets: ["RuntimeRaidersCore"]),
        .executable(name: "raiders", targets: ["RuntimeRaidersCLI"]),
    ],
    targets: [
        .target(
            name: "RuntimeRaidersSignalSupport",
            publicHeadersPath: "include"
        ),
        .target(
            name: "RuntimeRaidersCore",
            dependencies: ["RuntimeRaidersSignalSupport"]
        ),
        .executableTarget(
            name: "RuntimeRaidersCLI",
            dependencies: ["RuntimeRaidersCore"]
        ),
        .testTarget(
            name: "RuntimeRaidersCoreTests",
            dependencies: ["RuntimeRaidersCore", "RuntimeRaidersSignalSupport"]
        ),
    ]
)
