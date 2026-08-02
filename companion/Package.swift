// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RuntimeRaidersAgent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "RuntimeRaidersCore", targets: ["RuntimeRaidersCore"]),
    ],
    targets: [
        .target(name: "RuntimeRaidersCore"),
        .testTarget(
            name: "RuntimeRaidersCoreTests",
            dependencies: ["RuntimeRaidersCore"]
        ),
    ]
)
