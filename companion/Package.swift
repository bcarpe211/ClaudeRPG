// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RuntimeRaidersAgent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "RuntimeRaidersCore", targets: ["RuntimeRaidersCore"]),
        .executable(name: "raiders", targets: ["RuntimeRaidersCLI"]),
        .executable(
            name: "runtime-raiders-release-validator",
            targets: ["RuntimeRaidersReleaseValidator"]
        ),
    ],
    targets: [
        .target(name: "RuntimeRaidersCore"),
        .executableTarget(
            name: "RuntimeRaidersCLI",
            dependencies: ["RuntimeRaidersCore"]
        ),
        .executableTarget(
            name: "RuntimeRaidersReleaseValidator",
            dependencies: ["RuntimeRaidersCore"]
        ),
        .testTarget(
            name: "RuntimeRaidersCoreTests",
            dependencies: ["RuntimeRaidersCore"]
        ),
    ]
)
