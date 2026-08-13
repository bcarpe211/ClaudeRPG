import Darwin
import Foundation

public enum LegacyMigrationControlError: Error, Equatable {
    case invalidResponse
}

public struct LegacyMigrationControl {
    public typealias Exchange = (
        _ frame: Data,
        _ socketURL: URL,
        _ maximumFrameBytes: Int,
        _ timeoutSeconds: Int
    ) throws -> Data

    private let maximumFrameBytes: Int
    private let timeoutSeconds: Int
    private let exchange: Exchange

    public init() {
        maximumFrameBytes = 4_096
        timeoutSeconds = 30
        exchange = Self.liveExchange
    }

    init(
        maximumFrameBytes: Int = 4_096,
        timeoutSeconds: Int = 30,
        exchange: @escaping Exchange
    ) {
        self.maximumFrameBytes = max(1, min(maximumFrameBytes, 64 * 1_024))
        self.timeoutSeconds = max(1, min(timeoutSeconds, 30))
        self.exchange = exchange
    }

    public func prepare(paths: AgentPaths) throws -> ControlResponse {
        try invoke(command: "prepare_update", paths: paths)
    }

    public func resume(paths: AgentPaths) throws -> ControlResponse {
        try invoke(command: "resume_update", paths: paths)
    }

    private func invoke(command: String, paths: AgentPaths) throws -> ControlResponse {
        let response = try exchange(
            Data("{\"command\":\"\(command)\"}".utf8) + Data([0x0A]),
            paths.controlSocket,
            maximumFrameBytes,
            timeoutSeconds
        )
        return try Self.decode(response, maximumFrameBytes: maximumFrameBytes)
    }

    private static func decode(_ frame: Data, maximumFrameBytes: Int) throws -> ControlResponse {
        guard !frame.isEmpty,
              frame.count <= maximumFrameBytes,
              frame.last == 0x0A else {
            throw LegacyMigrationControlError.invalidResponse
        }
        let body = frame.dropLast()
        guard !body.isEmpty,
              !body.contains(0x0A),
              let object = try? JSONSerialization.jsonObject(with: body),
              let fields = object as? [String: Any],
              Set(fields.keys) == ["ok", "message"],
              fields["ok"] is Bool,
              fields["message"] is String,
              let response = try? JSONDecoder().decode(ControlResponse.self, from: body) else {
            throw LegacyMigrationControlError.invalidResponse
        }
        return response
    }

    private static func liveExchange(
        frame: Data,
        socketURL: URL,
        maximumFrameBytes: Int,
        timeoutSeconds: Int
    ) throws -> Data {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { Darwin.close(descriptor) }
        var noSignal: Int32 = 1
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &noSignal,
            socklen_t(MemoryLayout<Int32>.size)
        ) == 0 else { throw currentPOSIXError() }
        var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        for option in [SO_RCVTIMEO, SO_SNDTIMEO] {
            guard Darwin.setsockopt(
                descriptor,
                SOL_SOCKET,
                option,
                &timeout,
                socklen_t(MemoryLayout<timeval>.size)
            ) == 0 else { throw currentPOSIXError() }
        }
        try withAddress(socketURL.standardizedFileURL.path) { address, length in
            guard Darwin.connect(descriptor, address, length) == 0 else {
                throw currentPOSIXError()
            }
        }
        try writeAll(frame, to: descriptor)
        return try readFrame(descriptor, maximumFrameBytes: maximumFrameBytes)
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw currentPOSIXError() }
            }
        }
    }

    private static func readFrame(_ descriptor: Int32, maximumFrameBytes: Int) throws -> Data {
        var output = Data()
        var byte: UInt8 = 0
        while output.count <= maximumFrameBytes {
            let count = Darwin.read(descriptor, &byte, 1)
            if count == 1 {
                output.append(byte)
                if byte == 0x0A { return output }
            } else if count == 0 {
                throw LegacyMigrationControlError.invalidResponse
            } else if errno == EINTR {
                continue
            } else {
                throw currentPOSIXError()
            }
        }
        throw LegacyMigrationControlError.invalidResponse
    }

    private static func withAddress<T>(
        _ path: String,
        _ body: (UnsafePointer<sockaddr>, socklen_t) throws -> T
    ) throws -> T {
        let pathBytes = Array(path.utf8CString)
        var address = sockaddr_un()
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw LegacyMigrationControlError.invalidResponse
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
                _ = pathBytes.withUnsafeBufferPointer { source in
                    memcpy(destination, source.baseAddress!, pathBytes.count)
                }
            }
        }
        return try withUnsafePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                try body($0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
