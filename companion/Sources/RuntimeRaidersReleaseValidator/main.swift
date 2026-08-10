import Darwin
import Foundation
import RuntimeRaidersCore

guard (2...3).contains(CommandLine.arguments.count) else {
    fputs("usage: runtime-raiders-release-validator archive.zip [extracted-root]\n", stderr)
    exit(EX_USAGE)
}

do {
    _ = try ZipArchiveValidator.validate(
        URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: false)
    )
    if CommandLine.arguments.count == 3 {
        try ZipArchiveValidator.validateExtractedTree(
            URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        )
    }
} catch {
    fputs("release archive validation failed\n", stderr)
    exit(EXIT_FAILURE)
}
