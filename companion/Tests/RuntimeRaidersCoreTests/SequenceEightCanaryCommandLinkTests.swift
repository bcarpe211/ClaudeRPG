import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class SequenceEightCanaryCommandLinkTests: XCTestCase {
    func testRealSequenceEightHomebrewLayoutIsRecognizedAndOnlyExactLegacyLinkIsRetired() throws {
        try withFixture { fixture in
            let link = SequenceEightCanaryCommandLink(
                filesystemRoot: fixture.root,
                expectedRootUID: geteuid(),
                expectedHomebrewUID: geteuid()
            )
            let proof = try link.validate(
                recordedCommandPath: "/opt/homebrew/opt/libpq/bin/raiders",
                expectedShim: fixture.shim
            )

            try link.retire(proof)
            XCTAssertNoThrow(try link.retireIfPresent(
                commandRecord: fixture.commandRecord,
                expectedShim: fixture.shim
            ))

            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.legacyCommand.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.neighbor.path))
            XCTAssertEqual(try Data(contentsOf: fixture.neighbor), Data("leave me\n".utf8))
        }
    }

    func testNearMatchLayoutsFailClosedWithoutMutation() throws {
        enum Mutation: CaseIterable {
            case externalPath, wrongOptTarget, wrongCommandTarget, wrongOwner, unexpectedMode
        }
        for mutation in Mutation.allCases {
            try withFixture { fixture in
                var recorded = "/opt/homebrew/opt/libpq/bin/raiders"
                var expectedOwner = geteuid()
                switch mutation {
                case .externalPath:
                    recorded = "/opt/homebrew/bin/raiders"
                case .wrongOptTarget:
                    try FileManager.default.removeItem(at: fixture.optLink)
                    try FileManager.default.createSymbolicLink(
                        atPath: fixture.optLink.path,
                        withDestinationPath: "../Cellar/libpq/18.3"
                    )
                case .wrongCommandTarget:
                    try FileManager.default.removeItem(at: fixture.legacyCommand)
                    try FileManager.default.createSymbolicLink(
                        atPath: fixture.legacyCommand.path,
                        withDestinationPath: fixture.neighbor.path
                    )
                case .wrongOwner:
                    expectedOwner = geteuid() &+ 1
                case .unexpectedMode:
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o755],
                        ofItemAtPath: fixture.homebrewOpt.path
                    )
                }

                let link = SequenceEightCanaryCommandLink(
                    filesystemRoot: fixture.root,
                    expectedRootUID: geteuid(),
                    expectedHomebrewUID: expectedOwner
                )
                XCTAssertThrowsError(try link.validate(
                    recordedCommandPath: recorded,
                    expectedShim: fixture.shim
                ), "accepted mutation \(mutation)")
                XCTAssertTrue(
                    FileManager.default.fileExists(atPath: fixture.legacyCommand.path),
                    "mutated the legacy link for \(mutation)"
                )
                XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.neighbor.path))
            }
        }
    }

    func testInjectedRetirementFailuresLeaveTheOriginalLinkIntact() throws {
        for phase in SequenceEightCanaryCommandLink.RetirementFault.allCases {
            try withFixture { fixture in
                let link = SequenceEightCanaryCommandLink(
                    filesystemRoot: fixture.root,
                    expectedRootUID: geteuid(),
                    expectedHomebrewUID: geteuid(),
                    retirementFault: { current in
                        if current == phase { throw TestFailure.injected }
                    }
                )
                let proof = try link.validate(
                    recordedCommandPath: "/opt/homebrew/opt/libpq/bin/raiders",
                    expectedShim: fixture.shim
                )
                XCTAssertThrowsError(try link.retire(proof), "phase \(phase)")
                XCTAssertEqual(
                    try FileManager.default.destinationOfSymbolicLink(
                        atPath: fixture.legacyCommand.path
                    ),
                    fixture.shim.path
                )
                XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.neighbor.path))
            }
        }
    }

    private enum TestFailure: Error { case injected }

    private struct Fixture {
        let root: URL
        let homebrewOpt: URL
        let optLink: URL
        let legacyCommand: URL
        let commandRecord: URL
        let shim: URL
        let neighbor: URL
    }

    private func withFixture(_ body: (Fixture) throws -> Void) throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-sequence8-command-\(UUID().uuidString)", isDirectory: true)
        let opt = root.appendingPathComponent("opt", isDirectory: true)
        let homebrew = opt.appendingPathComponent("homebrew", isDirectory: true)
        let homebrewOpt = homebrew.appendingPathComponent("opt", isDirectory: true)
        let cellar = homebrew.appendingPathComponent("Cellar", isDirectory: true)
        let libpq = cellar.appendingPathComponent("libpq", isDirectory: true)
        let version = libpq.appendingPathComponent("18.4", isDirectory: true)
        let bin = version.appendingPathComponent("bin", isDirectory: true)
        let optLink = homebrewOpt.appendingPathComponent("libpq", isDirectory: false)
        let shim = root.appendingPathComponent("home/Library/Application Support/Runtime Raiders/raiders")
        let legacyCommand = bin.appendingPathComponent("raiders")
        let commandRecord = root.appendingPathComponent("migration/old-command-link")
        let neighbor = bin.appendingPathComponent("psql")
        try FileManager.default.createDirectory(at: homebrewOpt, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: shim.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: commandRecord.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        for (directory, mode) in [
            (root, 0o700), (opt, 0o755), (homebrew, 0o755), (homebrewOpt, 0o775),
            (cellar, 0o775), (libpq, 0o755), (version, 0o755), (bin, 0o755),
        ] {
            try FileManager.default.setAttributes(
                [.posixPermissions: mode],
                ofItemAtPath: directory.path
            )
        }
        try Data("#!/bin/sh\n".utf8).write(to: shim)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shim.path)
        try Data("/opt/homebrew/opt/libpq/bin/raiders\n".utf8).write(to: commandRecord)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: commandRecord.path
        )
        try Data("leave me\n".utf8).write(to: neighbor)
        try FileManager.default.createSymbolicLink(
            atPath: optLink.path,
            withDestinationPath: "../Cellar/libpq/18.4"
        )
        try FileManager.default.createSymbolicLink(
            atPath: legacyCommand.path,
            withDestinationPath: shim.path
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try body(Fixture(
            root: root,
            homebrewOpt: homebrewOpt,
            optLink: optLink,
            legacyCommand: legacyCommand,
            commandRecord: commandRecord,
            shim: shim,
            neighbor: neighbor
        ))
    }
}
