import CoreServices
import Foundation

public enum ApplicationRegistrationError: Error, Equatable, Sendable {
    case failed(Int32)
}

public struct ApplicationRegistration {
    public typealias Operation = (URL, Bool) -> Int32

    private let operation: Operation

    public init(_ operation: @escaping Operation) {
        self.operation = operation
    }

    public func register(bundleURL: URL) throws {
        let status = operation(bundleURL, true)
        guard status == noErr else {
            throw ApplicationRegistrationError.failed(status)
        }
    }

    public static var live: ApplicationRegistration {
        ApplicationRegistration { bundleURL, update in
            LSRegisterURL(bundleURL as CFURL, update)
        }
    }
}
