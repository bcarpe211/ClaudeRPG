import CryptoKit
import Foundation

public enum RunIdentityError: Error, Equatable {
    case invalidNativeID
    case invalidDedupeSecret
    case invalidRunKey
    case invalidSequence
}

public enum RunIdentity {
    private static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    private static let maximumIdentityBytes = 4_096
    private static let maximumSecretBytes = 1_024

    public static func key(
        provider: RunProvider,
        nativeID: String,
        dedupeSecret: Data
    ) throws -> String {
        let nativeBytes = Data(nativeID.utf8)
        guard !nativeBytes.isEmpty, nativeBytes.count <= maximumIdentityBytes else {
            throw RunIdentityError.invalidNativeID
        }
        guard !dedupeSecret.isEmpty, dedupeSecret.count <= maximumSecretBytes else {
            throw RunIdentityError.invalidDedupeSecret
        }

        var message = Data("runtime-raiders/run-key/v1".utf8)
        message.append(0)
        message.append(contentsOf: provider.rawValue.utf8)
        message.append(0)
        message.append(nativeBytes)
        return hmac(message: message, key: dedupeSecret)
    }

    public static func eventKey(runKey: String, sequence: Int64) throws -> String {
        guard let runKeyBytes = decodeLowerHex(runKey) else {
            throw RunIdentityError.invalidRunKey
        }
        guard (0...maximumSafeInteger).contains(sequence) else {
            throw RunIdentityError.invalidSequence
        }

        var message = Data("runtime-raiders/event-key/v1".utf8)
        message.append(0)
        message.append(contentsOf: String(sequence).utf8)
        return hmac(message: message, key: runKeyBytes)
    }

    private static func hmac(message: Data, key: Data) -> String {
        let code = HMAC<SHA256>.authenticationCode(
            for: message,
            using: SymmetricKey(data: key)
        )
        let hex = Array("0123456789abcdef".utf8)
        var rendered = [UInt8]()
        rendered.reserveCapacity(64)
        for byte in code {
            rendered.append(hex[Int(byte >> 4)])
            rendered.append(hex[Int(byte & 0x0f)])
        }
        return String(decoding: rendered, as: UTF8.self)
    }

    private static func decodeLowerHex(_ value: String) -> Data? {
        let characters = Array(value.utf8)
        guard characters.count == 64 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(32)
        for index in stride(from: 0, to: characters.count, by: 2) {
            guard let high = hexNibble(characters[index]),
                  let low = hexNibble(characters[index + 1]) else {
                return nil
            }
            bytes.append((high << 4) | low)
        }
        return Data(bytes)
    }

    private static func hexNibble(_ character: UInt8) -> UInt8? {
        switch character {
        case 48...57: character - 48
        case 97...102: character - 87
        default: nil
        }
    }
}
