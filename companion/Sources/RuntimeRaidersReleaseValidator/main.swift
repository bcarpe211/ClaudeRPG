import Darwin
import Foundation
import RuntimeRaidersCore

guard CommandLine.arguments.count == 2 else {
    fputs("usage: runtime-raiders-release-validator archive.zip\n", stderr)
    exit(EX_USAGE)
}

do {
    _ = try ZipArchiveValidator.validate(
        URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: false)
    )
} catch {
    fputs("release archive validation failed\n", stderr)
    exit(EXIT_FAILURE)
}
