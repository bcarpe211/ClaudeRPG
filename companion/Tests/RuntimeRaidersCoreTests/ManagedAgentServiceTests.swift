import XCTest
@testable import RuntimeRaidersCore

final class ManagedAgentServiceTests: XCTestCase {
    func testStatusReturnsTheCurrentManagedAgentStatus() throws {
        let controller = ManagedAgentServiceController(operations: .init(
            register: {},
            unregister: {},
            status: { .requiresApproval }
        ))

        XCTAssertEqual(try controller.perform(.status), .requiresApproval)
    }

    func testRegisterRequiresEnabledPostcondition() throws {
        var registered = false
        let controller = ManagedAgentServiceController(operations: .init(
            register: { registered = true },
            unregister: {},
            status: { registered ? .enabled : .notRegistered }
        ))

        XCTAssertEqual(try controller.perform(.register), .enabled)
    }

    func testRegisterRejectsApprovalAndNotFoundStates() {
        for status in [ManagedAgentStatus.requiresApproval, .notFound] {
            let controller = ManagedAgentServiceController(operations: .init(
                register: {}, unregister: {}, status: { status }
            ))

            XCTAssertThrowsError(try controller.perform(.register)) { error in
                XCTAssertEqual(
                    error as? ManagedAgentServiceError,
                    .unexpectedStatus(status)
                )
            }
        }
    }

    func testRegisterRejectsOperationThatDoesNotReachEnabled() {
        let controller = ManagedAgentServiceController(operations: .init(
            register: {},
            unregister: {},
            status: { .notRegistered }
        ))

        XCTAssertThrowsError(try controller.perform(.register)) { error in
            XCTAssertEqual(
                error as? ManagedAgentServiceError,
                .unexpectedStatus(.notRegistered)
            )
        }
    }

    func testUnregisterIsIdempotentAndRequiresNotRegisteredPostcondition() throws {
        var status = ManagedAgentStatus.enabled
        let controller = ManagedAgentServiceController(operations: .init(
            register: {}, unregister: { status = .notRegistered }, status: { status }
        ))

        XCTAssertEqual(try controller.perform(.unregister), .notRegistered)
        XCTAssertEqual(try controller.perform(.unregister), .notRegistered)
    }

    func testUnregisterRejectsOperationThatDoesNotReachNotRegistered() {
        let controller = ManagedAgentServiceController(operations: .init(
            register: {},
            unregister: {},
            status: { .enabled }
        ))

        XCTAssertThrowsError(try controller.perform(.unregister)) { error in
            XCTAssertEqual(
                error as? ManagedAgentServiceError,
                .unexpectedStatus(.enabled)
            )
        }
    }
}
