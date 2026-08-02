import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class JSONLReaderTests: XCTestCase {
    func testPartialTrailingLineIsRetainedUntilCompleted() throws {
        try withTemporaryFile(contents: Data("{\"one\":1}\n{\"two\":\"par".utf8)) { file in
            let first = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: 1_024
            )
            XCTAssertEqual(first.lines, [Data(#"{"one":1}"#.utf8)])
            XCTAssertEqual(first.cursor.partialLine, Data("{\"two\":\"par".utf8))

            let handle = try FileHandle(forWritingTo: file)
            try handle.seekToEnd()
            try handle.write(contentsOf: Data("tial\"}\n".utf8))
            try handle.close()

            let second = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 1_024
            )
            XCTAssertEqual(second.lines, [Data(#"{"two":"partial"}"#.utf8)])
            XCTAssertTrue(second.cursor.partialLine.isEmpty)
        }
    }

    func testRepeatedBoundedReadsReturnEveryCompleteLineExactlyOnce() throws {
        try withTemporaryFile(contents: Data("one\nsecond\nthree\n".utf8)) { file in
            var cursor = JSONLCursor()
            var lines: [Data] = []
            var observedReadSizes: [Int] = []

            for _ in 0..<8 {
                let result = try JSONLReader.readAppended(file: file, cursor: cursor, maxBytes: 4)
                lines.append(contentsOf: result.lines)
                observedReadSizes.append(result.bytesRead)
                cursor = result.cursor
            }

            XCTAssertEqual(lines, [Data("one".utf8), Data("second".utf8), Data("three".utf8)])
            XCTAssertTrue(observedReadSizes.allSatisfy { $0 <= 4 })
            XCTAssertEqual(observedReadSizes.filter { $0 > 0 }.reduce(0, +), 17)
        }
    }

    func testLineEndOffsetsAreStableAcrossDifferentCursorChunking() throws {
        try withTemporaryFile(contents: Data("one\nsecond\nthree\n".utf8)) { file in
            let oneShot = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: 100
            )
            var cursor = JSONLCursor()
            var boundedOffsets: [Int64] = []
            for _ in 0..<8 {
                let result = try JSONLReader.readAppended(
                    file: file,
                    cursor: cursor,
                    maxBytes: 4
                )
                boundedOffsets.append(contentsOf: result.lineEndOffsets)
                cursor = result.cursor
            }

            XCTAssertEqual(oneShot.lineEndOffsets, [4, 11, 17])
            XCTAssertEqual(boundedOffsets, oneShot.lineEndOffsets)
        }
    }

    func testEOFReturnsNoLinesAndLeavesCursorStable() throws {
        try withTemporaryFile(contents: Data("complete\n".utf8)) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            let eof = try JSONLReader.readAppended(file: file, cursor: first.cursor, maxBytes: 100)

            XCTAssertEqual(eof.lines, [])
            XCTAssertEqual(eof.bytesRead, 0)
            XCTAssertEqual(eof.cursor, first.cursor)
        }
    }

    func testTruncationDiscardsOldPartialBytesAndRestartsAtBeginning() throws {
        try withTemporaryFile(contents: Data("old-complete\nold-partial".utf8)) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertEqual(first.lines, [Data("old-complete".utf8)])
            XCTAssertEqual(first.cursor.partialLine, Data("old-partial".utf8))

            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: Data("new\n".utf8))
            try handle.close()

            let afterTruncation = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(afterTruncation.lines, [Data("new".utf8)])
            XCTAssertTrue(afterTruncation.cursor.partialLine.isEmpty)
            XCTAssertEqual(afterTruncation.cursor.offset, 4)
        }
    }

    func testInodeReplacementDiscardsOldPartialBytesAndReadsNewFile() throws {
        try withTemporaryFile(contents: Data("old-partial".utf8)) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertEqual(first.cursor.partialLine, Data("old-partial".utf8))

            let replacement = file.deletingLastPathComponent()
                .appendingPathComponent("replacement-\(UUID().uuidString)")
            try Data("replacement\n".utf8).write(to: replacement)
            try FileManager.default.removeItem(at: file)
            try FileManager.default.moveItem(at: replacement, to: file)

            let afterReplacement = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(afterReplacement.lines, [Data("replacement".utf8)])
            XCTAssertTrue(afterReplacement.cursor.partialLine.isEmpty)
            XCTAssertNotEqual(afterReplacement.cursor.fileIdentity, first.cursor.fileIdentity)
        }
    }

    func testEqualLengthSameInodeRegrowDiscardsStalePartialAndReadsNewPrefix() throws {
        let original = Data("old-complete\nold-partial".utf8)
        let replacement = Data("new-first\nnew-second\nxxx".utf8)
        XCTAssertEqual(original.count, replacement.count)

        try withTemporaryFile(contents: original) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertEqual(first.lines, [Data("old-complete".utf8)])
            XCTAssertEqual(first.cursor.partialLine, Data("old-partial".utf8))

            try replaceContentsPreservingInode(of: file, with: replacement)

            let afterRegrow = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(
                afterRegrow.lines,
                [Data("new-first".utf8), Data("new-second".utf8)]
            )
            XCTAssertEqual(afterRegrow.cursor.partialLine, Data("xxx".utf8))
            XCTAssertEqual(afterRegrow.cursor.fileIdentity, first.cursor.fileIdentity)
        }
    }

    func testGreaterLengthSameInodeRegrowDoesNotSkipNewPrefixWithoutPartialLine() throws {
        let original = Data("old-one\nold-two\n".utf8)
        let replacement = Data("first\nsecond\nthird\n".utf8)
        XCTAssertGreaterThan(replacement.count, original.count)

        try withTemporaryFile(contents: original) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertEqual(first.lines, [Data("old-one".utf8), Data("old-two".utf8)])
            XCTAssertTrue(first.cursor.partialLine.isEmpty)

            try replaceContentsPreservingInode(of: file, with: replacement)

            let afterRegrow = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(
                afterRegrow.lines,
                [Data("first".utf8), Data("second".utf8), Data("third".utf8)]
            )
            XCTAssertTrue(afterRegrow.cursor.partialLine.isEmpty)
            XCTAssertEqual(afterRegrow.cursor.fileIdentity, first.cursor.fileIdentity)
        }
    }

    func testEqualLengthSameInodeRegrowDoesNotSkipNewPrefixWithoutPartialLine() throws {
        let original = Data("old-a\nold-b\n".utf8)
        let replacement = Data("new-a\nnew-b\n".utf8)
        XCTAssertEqual(replacement.count, original.count)

        try withTemporaryFile(contents: original) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertTrue(first.cursor.partialLine.isEmpty)

            try replaceContentsPreservingInode(of: file, with: replacement)

            let afterRegrow = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(afterRegrow.lines, [Data("new-a".utf8), Data("new-b".utf8)])
            XCTAssertTrue(afterRegrow.cursor.partialLine.isEmpty)
        }
    }

    func testGreaterLengthSameInodeRegrowDiscardsStalePartialAndReadsNewPrefix() throws {
        let original = Data("old\npartial".utf8)
        let replacement = Data("first\nsecond\nmore".utf8)
        XCTAssertGreaterThan(replacement.count, original.count)

        try withTemporaryFile(contents: original) { file in
            let first = try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: 100)
            XCTAssertEqual(first.cursor.partialLine, Data("partial".utf8))

            try replaceContentsPreservingInode(of: file, with: replacement)

            let afterRegrow = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 100
            )
            XCTAssertEqual(afterRegrow.lines, [Data("first".utf8), Data("second".utf8)])
            XCTAssertEqual(afterRegrow.cursor.partialLine, Data("more".utf8))
        }
    }

    func testFinalComponentSymlinkIsRejectedWithoutReadingItsTarget() throws {
        try withTemporaryFile(contents: Data("DO_NOT_EXPORT_EXTERNAL_TARGET\n".utf8)) { target in
            let symlink = target.deletingLastPathComponent().appendingPathComponent("events-link.jsonl")
            try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: target)

            XCTAssertThrowsError(
                try JSONLReader.readAppended(file: symlink, cursor: JSONLCursor(), maxBytes: 100)
            )
            XCTAssertEqual(
                try Data(contentsOf: target),
                Data("DO_NOT_EXPORT_EXTERNAL_TARGET\n".utf8)
            )
        }
    }

    func testReadOnlyFileIsReadWithoutChangingContentOrMetadata() throws {
        let contents = Data("read-only\n".utf8)
        try withTemporaryFile(contents: contents) { file in
            XCTAssertEqual(Darwin.chmod(file.path, mode_t(S_IRUSR)), 0)
            defer { Darwin.chmod(file.path, mode_t(S_IRUSR | S_IWUSR)) }
            let before = try FileManager.default.attributesOfItem(atPath: file.path)

            let result = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: 100
            )

            let after = try FileManager.default.attributesOfItem(atPath: file.path)
            XCTAssertEqual(result.lines, [Data("read-only".utf8)])
            XCTAssertEqual(try Data(contentsOf: file), contents)
            XCTAssertEqual(after[.size] as? NSNumber, before[.size] as? NSNumber)
            XCTAssertEqual(after[.systemFileNumber] as? NSNumber, before[.systemFileNumber] as? NSNumber)
            XCTAssertEqual(after[.modificationDate] as? Date, before[.modificationDate] as? Date)
        }
    }

    func testMultibyteUTF8RecordSurvivesChunkBoundaryByteForByte() throws {
        let record = Data("{\"model\":\"mage-⚔️\"}".utf8)
        var contents = record
        contents.append(0x0A)
        let swordStart = try XCTUnwrap(contents.firstIndex(of: 0xe2))

        try withTemporaryFile(contents: contents) { file in
            let first = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: swordStart + 1
            )
            XCTAssertEqual(first.lines, [])

            let second = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: JSONLReader.maximumReadBytes
            )
            XCTAssertEqual(second.lines, [record])
            XCTAssertTrue(second.cursor.partialLine.isEmpty)
        }
    }

    func testInvalidCursorAndReadBoundsFailWithoutMutatingInput() throws {
        try withTemporaryFile(contents: Data("line\n".utf8)) { file in
            let negative = JSONLCursor(offset: -1)
            let missingIdentity = JSONLCursor(offset: 1)
            let oversizedPartial = JSONLCursor(
                offset: Int64(JSONLReader.maximumBufferedLineBytes + 1),
                fileIdentity: JSONLFileIdentity(device: 1, inode: 1),
                partialLine: Data(repeating: 1, count: JSONLReader.maximumBufferedLineBytes + 1)
            )

            XCTAssertThrowsError(try JSONLReader.readAppended(file: file, cursor: negative, maxBytes: 1))
            XCTAssertThrowsError(
                try JSONLReader.readAppended(file: file, cursor: missingIdentity, maxBytes: 1)
            )
            XCTAssertThrowsError(
                try JSONLReader.readAppended(file: file, cursor: oversizedPartial, maxBytes: 1)
            )
            XCTAssertEqual(negative, JSONLCursor(offset: -1))
            XCTAssertEqual(missingIdentity, JSONLCursor(offset: 1))
            XCTAssertEqual(oversizedPartial.partialLine.count, JSONLReader.maximumBufferedLineBytes + 1)
        }
    }

    func testInvalidMaximumByteCountsAreRejected() throws {
        try withTemporaryFile(contents: Data("line\n".utf8)) { file in
            for maxBytes in [-1, 0, JSONLReader.maximumReadBytes + 1] {
                XCTAssertThrowsError(
                    try JSONLReader.readAppended(file: file, cursor: JSONLCursor(), maxBytes: maxBytes),
                    "maxBytes=\(maxBytes)"
                )
            }
        }
    }

    func testCursorDecodesLegacyCodableStateWithoutContinuityCheckpoint() throws {
        let legacy = Data(
            #"{"offset":12,"fileIdentity":{"device":1,"inode":2},"partialLine":"cGFydGlhbA=="}"#.utf8
        )

        let cursor = try JSONDecoder().decode(JSONLCursor.self, from: legacy)

        XCTAssertEqual(cursor.offset, 12)
        XCTAssertEqual(cursor.fileIdentity, JSONLFileIdentity(device: 1, inode: 2))
        XCTAssertEqual(cursor.partialLine, Data("partial".utf8))
        XCTAssertNil(cursor.continuityCheckpoint)
    }

    func testCursorCodablePersistsOnlyBoundedDigestForContinuityTail() throws {
        let checkpoint = JSONLContinuityCheckpoint(
            byteCount: 4_096,
            digest: Data(repeating: 0xab, count: 32)
        )
        let cursor = JSONLCursor(
            offset: 4_096,
            fileIdentity: JSONLFileIdentity(device: 1, inode: 2),
            partialLine: Data(),
            continuityCheckpoint: checkpoint
        )

        let encoded = try JSONEncoder().encode(cursor)
        let decoded = try JSONDecoder().decode(JSONLCursor.self, from: encoded)

        XCTAssertEqual(decoded, cursor)
        XCTAssertEqual(decoded.continuityCheckpoint?.digest.count, 32)
        XCTAssertEqual(decoded.continuityCheckpoint?.byteCount, 4_096)
    }

    func testOversizedUnterminatedLineIsDiscardedUntilNewlineWithoutReturningItsContent() throws {
        var contents = Data(
            repeating: Character("x").asciiValue!,
            count: JSONLReader.maximumBufferedLineBytes + 2
        )
        contents.append(Data("\nvalid-after-oversized\n".utf8))
        try withTemporaryFile(contents: contents) { file in
            let first = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: JSONLReader.maximumReadBytes
            )
            XCTAssertEqual(first.cursor.partialLine.count, JSONLReader.maximumBufferedLineBytes)

            let recovery = try JSONLReader.readAppended(
                file: file,
                cursor: first.cursor,
                maxBytes: 1
            )
            XCTAssertEqual(recovery.lines, [])
            XCTAssertTrue(recovery.cursor.partialLine.isEmpty)

            let persisted = try JSONDecoder().decode(
                JSONLCursor.self,
                from: JSONEncoder().encode(recovery.cursor)
            )
            let afterRecovery = try JSONLReader.readAppended(
                file: file,
                cursor: persisted,
                maxBytes: JSONLReader.maximumReadBytes
            )
            XCTAssertEqual(afterRecovery.lines, [Data("valid-after-oversized".utf8)])
            XCTAssertTrue(afterRecovery.cursor.partialLine.isEmpty)
            XCTAssertEqual(afterRecovery.cursor.offset, Int64(contents.count))
        }
    }

    private func withTemporaryFile(contents: Data, _ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("runtime-raiders-jsonl-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("events.jsonl")
        try contents.write(to: file)
        try body(file)
    }

    private func replaceContentsPreservingInode(of file: URL, with contents: Data) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: contents)
        try handle.synchronize()
    }
}
