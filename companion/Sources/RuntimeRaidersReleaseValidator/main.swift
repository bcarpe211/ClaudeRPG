import Darwin
import Foundation
import RuntimeRaidersCore

guard [2, 8].contains(CommandLine.arguments.count) else {
    fputs(
        "usage: runtime-raiders-release-validator archive.zip [extracted-root sequence sha version protocol team]\n",
        stderr
    )
    exit(EX_USAGE)
}

do {
    _ = try ZipArchiveValidator.validate(
        URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: false)
    )
    if CommandLine.arguments.count == 8 {
        let sequenceText = CommandLine.arguments[3]
        let protocolText = CommandLine.arguments[6]
        guard sequenceText.first != "+",
              protocolText.first != "+",
              let sequence = Int64(sequenceText),
              let updateProtocol = Int(protocolText),
              String(sequence) == sequenceText,
              String(updateProtocol) == protocolText else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        let expected = CompanionReleaseIdentity(
            releaseSequence: sequence,
            releaseSHA: CommandLine.arguments[4],
            companionVersion: CommandLine.arguments[5],
            updateProtocolVersion: updateProtocol
        )
        _ = try ReleaseArchiveVerifier().verifyInstallerRelease(
            extractedRoot: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true),
            expected: expected,
            expectedTeamIdentifier: CommandLine.arguments[7]
        )
    }
} catch {
    fputs("release archive validation failed\n", stderr)
    exit(EXIT_FAILURE)
}
