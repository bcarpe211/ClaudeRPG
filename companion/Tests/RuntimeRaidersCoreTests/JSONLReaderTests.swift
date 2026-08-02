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

    func testOversizedUnterminatedLineFailsClosedAtBufferLimit() throws {
        try withTemporaryFile(
            contents: Data(repeating: Character("x").asciiValue!, count: JSONLReader.maximumBufferedLineBytes + 1)
        ) { file in
            let first = try JSONLReader.readAppended(
                file: file,
                cursor: JSONLCursor(),
                maxBytes: JSONLReader.maximumReadBytes
            )
            XCTAssertEqual(first.cursor.partialLine.count, JSONLReader.maximumBufferedLineBytes)

            XCTAssertThrowsError(
                try JSONLReader.readAppended(file: file, cursor: first.cursor, maxBytes: 1)
            )
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
}
