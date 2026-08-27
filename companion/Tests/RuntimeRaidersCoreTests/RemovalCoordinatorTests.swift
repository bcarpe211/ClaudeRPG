import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RemovalCoordinatorTests: XCTestCase {
    func testPreserveModeUsesExactOrderAndVerifiesPreservedState() throws {
        let fixture = CoordinatorFixture()

        XCTAssertEqual(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .preserveState),
            .removedPreservingState
        )
        XCTAssertEqual(fixture.actions, [
            "lock", "persist-off", "stop-daemon", "unregister", "verify-unregistered",
            "prepare-session", "remove-executable-artifacts", "verify-preserved-state",
        ])
    }

    func testEverythingWithQueueRevokesBeforeDiscardAndRemovalInExactOrder() throws {
        let fixture = CoordinatorFixture()
        fixture.queueCount = 3
        fixture.enrollment = try makeEnrollment()

        XCTAssertEqual(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything),
            .removedEverything
        )
        XCTAssertEqual(fixture.actions, [
            "lock", "persist-off", "stop-daemon", "unregister", "verify-unregistered",
            "prepare-session", "queue-snapshot", "summarize", "confirm-discard",
            "confirm-everything", "load-enrollment", "revoke", "verify-revoked",
            "discard-queue", "verify-queue-empty", "remove-all-artifacts",
        ])
    }

    func testCancellationHappensBeforeEnrollmentRevocationDiscardOrDeletion() throws {
        for cancelDiscard in [true, false] {
            let fixture = CoordinatorFixture()
            fixture.queueCount = 2
            fixture.enrollment = try makeEnrollment()
            fixture.confirmDiscard = !cancelDiscard
            fixture.confirmEverything = cancelDiscard

            XCTAssertEqual(
                try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything),
                .cancelled
            )
            XCTAssertFalse(fixture.actions.contains("revoke"))
            XCTAssertFalse(fixture.actions.contains("discard-queue"))
            XCTAssertFalse(fixture.actions.contains("remove-all-artifacts"))
        }
    }

    func testEveryRevocationFailureFailsClosedBeforeDiscardOrDeletion() throws {
        let failures: [[Result<Bool, Error>]] = [
            Array(repeating: .failure(CoordinatorError.transport), count: 5),
            Array(repeating: .success(false), count: 5),
            [.failure(CoordinatorError.transport), .success(false), .failure(CoordinatorError.transport), .success(false), .success(false)],
        ]
        for results in failures {
            let fixture = CoordinatorFixture()
            fixture.queueCount = 1
            fixture.enrollment = try makeEnrollment()
            fixture.revokeResults = results

            XCTAssertEqual(
                try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything),
                .revocationRequired
            )
            XCTAssertEqual(fixture.delays, [100, 250, 500, 1_000])
            XCTAssertEqual(fixture.actions.filter { $0 == "revoke" }.count, 5)
            XCTAssertFalse(fixture.actions.contains("discard-queue"))
            XCTAssertFalse(fixture.actions.contains("remove-all-artifacts"))
        }
    }

    func testBoundedRetryAcceptsOnlyExplicitIdempotentRevocationProof() throws {
        let fixture = CoordinatorFixture()
        fixture.enrollment = try makeEnrollment()
        fixture.revokeResults = [
            .failure(CoordinatorError.transport),
            .failure(CoordinatorError.transport),
            .success(true),
        ]

        XCTAssertEqual(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything),
            .removedEverything
        )
        XCTAssertEqual(fixture.delays, [100, 250])
        XCTAssertLessThan(
            try XCTUnwrap(fixture.actions.firstIndex(of: "verify-revoked")),
            try XCTUnwrap(fixture.actions.firstIndex(of: "remove-all-artifacts"))
        )
    }

    func testVerifiedMissingEnrollmentSkipsRevocationButCorruptEnrollmentFailsClosed() throws {
        let missing = CoordinatorFixture()
        missing.enrollment = nil
        XCTAssertEqual(
            try RemovalCoordinator(operations: missing.operations()).run(mode: .everything),
            .removedEverything
        )
        XCTAssertFalse(missing.actions.contains("revoke"))
        XCTAssertTrue(missing.actions.contains("remove-all-artifacts"))

        let corrupt = CoordinatorFixture()
        corrupt.loadEnrollmentError = CoordinatorError.corrupt
        XCTAssertEqual(
            try RemovalCoordinator(operations: corrupt.operations()).run(mode: .everything),
            .assistedRecoveryRequired
        )
        XCTAssertFalse(corrupt.actions.contains("revoke"))
        XCTAssertFalse(corrupt.actions.contains("discard-queue"))
        XCTAssertFalse(corrupt.actions.contains("remove-all-artifacts"))
    }

    func testPreRemovalFailuresAreContentFreeAndDoNotClaimSuccess() throws {
        let fixture = CoordinatorFixture()
        fixture.verifyUnregistered = false
        let secret = String(repeating: "s", count: 43)
        fixture.throwingError = SecretError(value: secret)

        XCTAssertThrowsError(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything)
        ) { error in
            XCTAssertEqual(error as? RemovalCoordinatorError, .operationFailed)
            XCTAssertFalse(String(describing: error).contains(secret))
            XCTAssertFalse(String(reflecting: error).contains(secret))
        }
        XCTAssertFalse(fixture.actions.contains("discard-queue"))
        XCTAssertFalse(fixture.actions.contains("remove-all-artifacts"))
    }

    func testCompleteRemovalAuthorizationIsBoundToThePreparedSessionAndFinalQueueProof() throws {
        let fixture = CoordinatorFixture()
        fixture.queueCount = 1
        fixture.enrollment = try makeEnrollment()

        XCTAssertEqual(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything),
            .removedEverything
        )
        XCTAssertEqual(fixture.preparedSessions.count, 1)
        XCTAssertTrue(fixture.receivedBoundAuthorization)
        XCTAssertLessThan(
            try XCTUnwrap(fixture.actions.firstIndex(of: "verify-queue-empty")),
            try XCTUnwrap(fixture.actions.firstIndex(of: "remove-all-artifacts"))
        )
        XCTAssertEqual(Set(fixture.sessionIdentities).count, 1)
    }

    func testZeroQueueStillRequiresFinalExactEmptyProofBeforeDeletion() throws {
        let fixture = CoordinatorFixture()
        fixture.queueCount = 0
        fixture.verifyQueueEmpty = false

        XCTAssertThrowsError(
            try RemovalCoordinator(operations: fixture.operations()).run(mode: .everything)
        )
        XCTAssertTrue(fixture.actions.contains("verify-queue-empty"))
        XCTAssertFalse(fixture.actions.contains("discard-queue"))
        XCTAssertFalse(fixture.actions.contains("remove-all-artifacts"))
    }

    func testCoordinatorCanIdempotentlyCompleteAnAlreadyRemovedSession() throws {
        let fixture = CoordinatorFixture()
        let coordinator = RemovalCoordinator(operations: fixture.operations())

        XCTAssertEqual(try coordinator.run(mode: .everything), .removedEverything)
        XCTAssertEqual(try coordinator.run(mode: .everything), .removedEverything)
        XCTAssertEqual(fixture.actions.filter { $0 == "remove-all-artifacts" }.count, 2)
        XCTAssertEqual(fixture.preparedSessions.count, 2)
    }
}

private final class CoordinatorFixture {
    var actions: [String] = []
    var delays: [Int] = []
    var queueCount = 0
    var enrollment: EnrollmentConfiguration?
    var loadEnrollmentError: Error?
    var revokeResults: [Result<Bool, Error>] = [.success(true)]
    var confirmDiscard = true
    var confirmEverything = true
    var verifyUnregistered = true
    var verifyQueueEmpty = true
    var throwingError: Error?
    var preparedSessions: [CoordinatorSession] = []
    var sessionIdentities: [ObjectIdentifier] = []
    var receivedBoundAuthorization = false

    func operations() -> RemovalOperations {
        RemovalOperations(
            acquireLock: { self.actions.append("lock"); return CoordinatorLock() },
            persistCollectionOff: { self.actions.append("persist-off") },
            stopDaemon: { self.actions.append("stop-daemon") },
            unregisterAgent: { self.actions.append("unregister") },
            verifyAgentUnregistered: {
                self.actions.append("verify-unregistered")
                if let error = self.throwingError { throw error }
                return self.verifyUnregistered
            },
            prepareSession: {
                self.actions.append("prepare-session")
                let session = CoordinatorSession()
                self.preparedSessions.append(session)
                return session
            },
            queueSnapshot: { session in
                self.actions.append("queue-snapshot")
                self.sessionIdentities.append(ObjectIdentifier(session))
                return RemovalQueueSnapshot(
                    sessionIdentifier: ObjectIdentifier(session),
                    names: (0..<self.queueCount).map { "record-\($0)" }
                )
            },
            summarize: { _ in self.actions.append("summarize") },
            confirmDiscard: { _ in
                self.actions.append("confirm-discard")
                return self.confirmDiscard
            },
            confirmEverything: {
                self.actions.append("confirm-everything")
                return self.confirmEverything
            },
            loadEnrollment: { session in
                self.actions.append("load-enrollment")
                self.sessionIdentities.append(ObjectIdentifier(session))
                if let error = self.loadEnrollmentError { throw error }
                return self.enrollment
            },
            revoke: { _ in
                self.actions.append("revoke")
                let result = self.revokeResults.isEmpty
                    ? Result<Bool, Error>.failure(CoordinatorError.transport)
                    : self.revokeResults.removeFirst()
                return try result.get()
            },
            delayMilliseconds: { delay in self.delays.append(delay) },
            discardQueue: { session, _ in
                self.sessionIdentities.append(ObjectIdentifier(session))
                self.actions.append("discard-queue")
            },
            verifyQueueEmpty: { session, _ in
                self.sessionIdentities.append(ObjectIdentifier(session))
                self.actions.append("verify-queue-empty")
                return self.verifyQueueEmpty
            },
            removeExecutableArtifacts: { session in
                self.sessionIdentities.append(ObjectIdentifier(session))
                self.actions.append("remove-executable-artifacts")
            },
            verifyPreservedState: { session in
                self.sessionIdentities.append(ObjectIdentifier(session))
                self.actions.append("verify-preserved-state")
                return true
            },
            removeAllArtifacts: { session, authorization in
                self.sessionIdentities.append(ObjectIdentifier(session))
                self.receivedBoundAuthorization = authorization.authorizes(session)
                self.actions.append("remove-all-artifacts")
            },
            revocationProof: { self.actions.append("verify-revoked") }
        )
    }
}

private final class CoordinatorLock: RemovalLock, @unchecked Sendable {}
private final class CoordinatorSession: RemovalSession, @unchecked Sendable {}

private enum CoordinatorError: Error { case transport, corrupt }

private struct SecretError: Error, CustomStringConvertible {
    let value: String
    var description: String { value }
}

private func makeEnrollment() throws -> EnrollmentConfiguration {
    try EnrollmentConfiguration(
        deviceID: "11111111-1111-4111-8111-111111111111",
        deviceToken: String(repeating: "t", count: 43),
        dedupeSecret: Data(repeating: 0x11, count: 32),
        serverURL: URL(string: "https://raiders.redlattice.com")!,
        cutoverAtMS: 0,
        enabledSurfaces: [.codexCLI, .codexDesktop]
    )
}
