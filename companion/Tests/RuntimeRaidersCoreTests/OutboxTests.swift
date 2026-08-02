import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class OutboxTests: XCTestCase {
    func testEnqueuePersistsOnePrivatePrivacyEncodedEventAndSurvivesRestart() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            let event = makeEvent(sequence: 7, observedAtMS: 1_700_000_001_500)

            try outbox.enqueue(event)
            try outbox.enqueue(event)

            let records = try Outbox(directory: directory).records(limit: 100)
            XCTAssertEqual(records.count, 1)
            XCTAssertEqual(records[0].event, event)
            XCTAssertEqual(records[0].encodedEvent, try PrivacyEncoder().encode(event))
            XCTAssertEqual(try permissions(of: records[0].url), 0o600)
            XCTAssertEqual(try permissions(of: directory), 0o700)
            XCTAssertFalse(String(decoding: records[0].encodedEvent, as: UTF8.self).contains("DO_NOT_EXPORT"))
            XCTAssertFalse(try directoryNames(directory).contains { $0.contains("runtime-raiders-tmp") })
        }
    }

    func testSameIdempotencyKeyWithLaterObservationRetainsOneStableFile() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            let first = makeEvent(sequence: 7, observedAtMS: 1_700_000_001_500)
            var replayed = first
            replayed.observedAtMS += 5_000
            var conflicting = replayed
            conflicting.state = .completed

            try outbox.enqueue(first)
            try outbox.enqueue(replayed)
            XCTAssertThrowsError(try outbox.enqueue(conflicting))

            XCTAssertEqual(try outbox.records(limit: 100).map(\.event), [first])
            XCTAssertEqual(try directoryNames(directory).count, 1)
        }
    }

    func testSameIdempotencyKeyAcrossCodexSurfacesRetainsOneStableFile() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            let first = makeEvent(sequence: 7, observedAtMS: 1_700_000_001_500)
            var crossSurfaceReplay = first
            crossSurfaceReplay.surface = .codexDesktop
            crossSurfaceReplay.observedAtMS += 5_000

            try outbox.enqueue(first)
            try outbox.enqueue(crossSurfaceReplay)

            XCTAssertEqual(try outbox.records(limit: 100).map(\.event), [first])
            XCTAssertEqual(try directoryNames(directory).count, 1)
        }
    }

    func testPruneExpiresSevenDayRecordsThenDropsOldestUntilWithinByteLimit() throws {
        try withTemporaryDirectory { directory in
            let now: Int64 = 1_800_000_000_000
            let sampleBytes = try PrivacyEncoder().encode(makeEvent(sequence: 1, observedAtMS: now)).count
            let outbox = try Outbox(
                directory: directory,
                maximumBytes: sampleBytes * 2,
                maximumAgeMS: 7 * 24 * 60 * 60 * 1_000
            )
            try outbox.enqueue(makeEvent(sequence: 1, observedAtMS: now - 7 * 24 * 60 * 60 * 1_000 - 1))
            try outbox.enqueue(makeEvent(sequence: 2, observedAtMS: now - 3_000))
            try outbox.enqueue(makeEvent(sequence: 3, observedAtMS: now - 2_000))
            try outbox.enqueue(makeEvent(sequence: 4, observedAtMS: now - 1_000))

            try outbox.prune(nowMS: now)

            XCTAssertEqual(try outbox.records(limit: 100).map(\.event.sequence), [3, 4])
            XCTAssertLessThanOrEqual(try outbox.totalBytes(), sampleBytes * 2)
        }
    }

    func testRecordsIgnoreUnownedFilesAndAcknowledgementDeletesOnlySelectedRecords() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1, observedAtMS: 1_700_000_001_001))
            try outbox.enqueue(makeEvent(sequence: 2, observedAtMS: 1_700_000_001_002))
            let unrelated = directory.appendingPathComponent("DO_NOT_EXPORT-unrelated.txt")
            try Data("leave me".utf8).write(to: unrelated)
            let first = try XCTUnwrap(outbox.records(limit: 1).first)

            try outbox.acknowledge([first])

            XCTAssertEqual(try outbox.records(limit: 100).map(\.event.sequence), [2])
            XCTAssertEqual(try Data(contentsOf: unrelated), Data("leave me".utf8))
        }
    }

    func testSymlinkedDirectoryAndOwnedNameRecordSymlinkAreRejectedWithoutTouchingTargets() throws {
        let parent = canonicalTemporaryDirectory()
            .appendingPathComponent("runtime-raiders-outbox-links-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: parent) }
        let targetDirectory = parent.appendingPathComponent("target", isDirectory: true)
        try FileManager.default.createDirectory(at: targetDirectory, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: targetDirectory.path)
        let directoryLink = parent.appendingPathComponent("outbox-link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: directoryLink, withDestinationURL: targetDirectory)

        XCTAssertThrowsError(try Outbox(directory: directoryLink))
        XCTAssertEqual(try permissions(of: targetDirectory), 0o755)

        let outboxDirectory = parent.appendingPathComponent("outbox", isDirectory: true)
        let outbox = try Outbox(directory: outboxDirectory)
        let targetFile = parent.appendingPathComponent("outside.json")
        let targetData = try PrivacyEncoder().encode(
            makeEvent(sequence: 9, observedAtMS: 1_700_000_001_009)
        )
        try targetData.write(to: targetFile)
        let ownedName = String(repeating: "a", count: 64) + ".json"
        try FileManager.default.createSymbolicLink(
            at: outboxDirectory.appendingPathComponent(ownedName),
            withDestinationURL: targetFile
        )

        XCTAssertTrue(try outbox.records(limit: 100).isEmpty)
        XCTAssertEqual(try Data(contentsOf: targetFile), targetData)
    }

    func testRepeatedScansAreStableAndCorruptOwnedFilesStillCountTowardDiskCap() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory, maximumBytes: 20)
            let firstName = String(repeating: "a", count: 64) + ".json"
            let secondName = String(repeating: "b", count: 64) + ".json"
            try Data(repeating: 0x78, count: 15).write(
                to: directory.appendingPathComponent(firstName)
            )
            try Data(repeating: 0x79, count: 15).write(
                to: directory.appendingPathComponent(secondName)
            )
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: 1)],
                ofItemAtPath: directory.appendingPathComponent(firstName).path
            )
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: 2)],
                ofItemAtPath: directory.appendingPathComponent(secondName).path
            )

            XCTAssertTrue(try outbox.records(limit: 100).isEmpty)
            XCTAssertTrue(try outbox.records(limit: 100).isEmpty)
            try outbox.prune(nowMS: 10)

            let owned = try FileManager.default.contentsOfDirectory(atPath: directory.path)
                .filter { $0.hasSuffix(".json") }
            let physicalBytes = try owned.reduce(0) { total, name in
                let attributes = try FileManager.default.attributesOfItem(
                    atPath: directory.appendingPathComponent(name).path
                )
                return total + ((attributes[.size] as? NSNumber)?.intValue ?? 0)
            }
            XCTAssertLessThanOrEqual(physicalBytes, 20)
            XCTAssertEqual(owned, [secondName])
        }
    }

    func testPruneExpiresOldCorruptOwnedFilesByDescriptorTimestamp() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(
                directory: directory,
                maximumBytes: 1_024,
                maximumAgeMS: 1_000
            )
            let oldName = String(repeating: "a", count: 64) + ".json"
            let freshName = String(repeating: "b", count: 64) + ".json"
            try Data("corrupt-old".utf8).write(to: directory.appendingPathComponent(oldName))
            try Data("corrupt-fresh".utf8).write(to: directory.appendingPathComponent(freshName))
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: 1)],
                ofItemAtPath: directory.appendingPathComponent(oldName).path
            )
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: 2)],
                ofItemAtPath: directory.appendingPathComponent(freshName).path
            )

            try outbox.prune(nowMS: 2_001)

            XCTAssertEqual(try directoryNames(directory), [freshName])
        }
    }

    func testUploadSelectionPreservesSameRunSequenceWhenObservedTimesRegress() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1, observedAtMS: 1_700_000_002_000))
            try outbox.enqueue(makeEvent(sequence: 2, observedAtMS: 1_700_000_001_000))

            XCTAssertEqual(try outbox.records(limit: 100).map(\.event.sequence), [1, 2])
        }
    }

    private func makeEvent(sequence: Int64, observedAtMS: Int64) -> RunEventV1 {
        let startedAt = observedAtMS - 1_000
        return RunEventV1(
            schemaVersion: 1,
            companionVersion: "0.1.0",
            deviceID: "00000000-0000-4000-8000-000000000001",
            provider: .codex,
            surface: .codexCLI,
            runKey: String(repeating: "a", count: 64),
            sequence: sequence,
            eventTimeMS: startedAt + 500,
            observedAtMS: observedAtMS,
            startedAtMS: startedAt,
            state: .open,
            usage: .init(input: sequence, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
            model: nil,
            effort: nil,
            idempotencyKey: String(format: "%064llx", sequence)
        )
    }

    private func permissions(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func directoryNames(_ directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path)
    }

    private func withTemporaryDirectory(_ body: (URL) throws -> Void) throws {
        let root = canonicalTemporaryDirectory()
            .appendingPathComponent("runtime-raiders-outbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func canonicalTemporaryDirectory() -> URL {
        let temporary = FileManager.default.temporaryDirectory
        return temporary.path == "/var" || temporary.path.hasPrefix("/var/")
            ? URL(fileURLWithPath: "/private" + temporary.path, isDirectory: true)
            : temporary
    }
}
