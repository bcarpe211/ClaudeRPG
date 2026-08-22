import Foundation
import ServiceManagement

public enum ManagedAgentAction: String, Equatable, Sendable {
    case register
    case unregister
    case status
}

public enum ManagedAgentStatus: String, Equatable, Sendable {
    case notRegistered = "not-registered"
    case enabled
    case requiresApproval = "requires-approval"
    case notFound = "not-found"
}

public enum ManagedAgentServiceError: Error, Equatable, Sendable {
    case unexpectedStatus(ManagedAgentStatus)
}

public struct ManagedAgentServiceOperations: @unchecked Sendable {
    public let register: () throws -> Void
    public let unregister: () throws -> Void
    public let status: () -> ManagedAgentStatus

    public init(
        register: @escaping () throws -> Void,
        unregister: @escaping () throws -> Void,
        status: @escaping () -> ManagedAgentStatus
    ) {
        self.register = register
        self.unregister = unregister
        self.status = status
    }
}

public struct ManagedAgentServiceController: Sendable {
    public static let plistName = "com.redlattice.runtime-raiders.agent.plist"

    public let operations: ManagedAgentServiceOperations

    public init(operations: ManagedAgentServiceOperations) {
        self.operations = operations
    }

    public func perform(_ action: ManagedAgentAction) throws -> ManagedAgentStatus {
        switch action {
        case .status:
            return operations.status()
        case .register:
            let initialStatus = operations.status()
            switch initialStatus {
            case .enabled:
                return .enabled
            case .notRegistered:
                try operations.register()
                let finalStatus = operations.status()
                guard finalStatus == .enabled else {
                    throw ManagedAgentServiceError.unexpectedStatus(finalStatus)
                }
                return finalStatus
            case .requiresApproval, .notFound:
                throw ManagedAgentServiceError.unexpectedStatus(initialStatus)
            }
        case .unregister:
            let initialStatus = operations.status()
            switch initialStatus {
            case .notRegistered:
                return .notRegistered
            case .enabled, .requiresApproval:
                try operations.unregister()
                let finalStatus = operations.status()
                guard finalStatus == .notRegistered else {
                    throw ManagedAgentServiceError.unexpectedStatus(finalStatus)
                }
                return finalStatus
            case .notFound:
                throw ManagedAgentServiceError.unexpectedStatus(initialStatus)
            }
        }
    }

    public static var live: ManagedAgentServiceController {
        let service = SMAppService.agent(plistName: plistName)
        return ManagedAgentServiceController(operations: ManagedAgentServiceOperations(
            register: { try service.register() },
            unregister: { try service.unregister() },
            status: { managedStatus(for: service.status) }
        ))
    }

    private static func managedStatus(for status: SMAppService.Status) -> ManagedAgentStatus {
        switch status {
        case .notRegistered:
            return .notRegistered
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .notFound
        @unknown default:
            return .notFound
        }
    }
}
