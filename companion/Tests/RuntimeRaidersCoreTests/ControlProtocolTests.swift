import Darwin
import Foundation
import RuntimeRaidersSignalSupport
import XCTest
@testable import RuntimeRaidersCore

nonisolated(unsafe) private var lifecycleRestorationSignalWriteDescriptor: Int32 = -1

private func lifecycleRestorationPriorSignalHandler(_ signal: Int32) {
    let descriptor = lifecycleRestorationSignalWriteDescriptor
    guard descriptor >= 0 else { return }
    var byte = UInt8(truncatingIfNeeded: signal)
    _ = Darwin.write(descriptor, &byte, 1)
}

final class ControlProtocolTests: XCTestCase {
    func testCompanionLifecyclePathsExposeOnlyTheExactOwnedInventory() throws {
        let paths = try CompanionLifecyclePaths(
            homeDirectory: URL(fileURLWithPath: "/Users/test", isDirectory: true)
        )

        XCTAssertEqual(
            paths.agent.supportDirectory.path,
            "/Users/test/Library/Application Support/Runtime Raiders"
        )
        XCTAssertEqual(
            paths.supportShim.path,
            "/Users/test/Library/Application Support/Runtime Raiders/raiders"
        )
        XCTAssertEqual(paths.commandShim.path, "/Users/test/.local/bin/raiders")
        XCTAssertEqual(
            paths.managedPlist.path,
            "/Users/test/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist"
        )
        XCTAssertEqual(
            paths.legacyPlist.path,
            "/Users/test/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
        )
        XCTAssertEqual(
            paths.enrollment.path,
            "/Users/test/Library/Application Support/Runtime Raiders/state/enrollment.json"
        )
        XCTAssertEqual(paths.recoveryJournal.lastPathComponent, "re-enrollment.json")
        XCTAssertEqual(
            paths.lifecycleLock.path,
            "/Users/test/Library/Application Support/.runtime-raiders.lifecycle.lock"
        )
    }

    func testCompanionLifecyclePathsRejectNonFileRelativeAndNonstandardHomes() {
        XCTAssertThrowsError(
            try CompanionLifecyclePaths(homeDirectory: URL(string: "https://example.test/home")!)
        )
        XCTAssertThrowsError(
            try CompanionLifecyclePaths(homeDirectory: URL(string: "relative-home")!)
        )
        XCTAssertThrowsError(
            try CompanionLifecyclePaths(
                homeDirectory: URL(fileURLWithPath: "/Users/test/../other", isDirectory: true)
            )
        )
    }

    func testLifecycleVerificationLockAcceptsOnlyExactFixtureAndEnforcesExclusion() throws {
        var template = Array("/private/tmp/rrv.XXXXXX".utf8CString)
        let created = template.withUnsafeMutableBufferPointer { pointer -> String? in
            guard let path = Darwin.mkdtemp(pointer.baseAddress) else { return nil }
            return String(cString: path)
        }
        let root = URL(fileURLWithPath: try XCTUnwrap(created), isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let applicationSupport = root.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: applicationSupport,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        for directory in [root, root.appendingPathComponent("Library"), applicationSupport] {
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }
        let marker = try CompanionLifecyclePaths(homeDirectory: root).lifecycleLock

        do {
            let held = try LifecycleLock.acquireLifecycleVerification(at: marker)
            XCTAssertThrowsError(try LifecycleLock.acquireLifecycleVerification(at: marker))
            withExtendedLifetime(held) {}
        }
        do {
            let reacquired = try LifecycleLock.acquireLifecycleVerification(at: marker)
            withExtendedLifetime(reacquired) {}
        }
        try FileManager.default.removeItem(at: marker)
        try FileManager.default.createSymbolicLink(
            at: marker,
            withDestinationURL: root.appendingPathComponent("outside-lock")
        )
        XCTAssertThrowsError(try LifecycleLock.acquireLifecycleVerification(at: marker))
        try FileManager.default.removeItem(at: marker)

        for rejected in [
            root.appendingPathComponent("Library/Application Support/not-the-lock"),
            root.appendingPathComponent(
                "home/Library/Application Support/.runtime-raiders.lifecycle.lock"
            ),
            URL(fileURLWithPath:
                "/private/tmp/not-rrv/Library/Application Support/.runtime-raiders.lifecycle.lock"
            ),
            URL(fileURLWithPath:
                "/private/tmp/rrv.TOOLONG/Library/Application Support/.runtime-raiders.lifecycle.lock"
            ),
        ] {
            XCTAssertThrowsError(try LifecycleLock.acquireLifecycleVerification(at: rejected))
        }
    }

    func testAgentPathsExposeOneStableApplicationWithoutChangingStatePaths() {
        let root = URL(fileURLWithPath: "/Users/test/Library/Application Support")
        let paths = AgentPaths(applicationSupportDirectory: root)
        let support = root.appendingPathComponent("Runtime Raiders", isDirectory: true)
        let application = support.appendingPathComponent(
            "Runtime Raiders.app",
            isDirectory: true
        )

        XCTAssertEqual(paths.supportDirectory, support)
        XCTAssertEqual(
            paths.stateDirectory,
            support.appendingPathComponent("state", isDirectory: true)
        )
        XCTAssertEqual(
            paths.outboxDirectory,
            support.appendingPathComponent("outbox", isDirectory: true)
        )
        XCTAssertEqual(
            paths.controlSocket,
            support.appendingPathComponent("agent.sock", isDirectory: false)
        )
        XCTAssertEqual(paths.agentApplication, application)
        XCTAssertEqual(
            paths.agentExecutable,
            application.appendingPathComponent(
                "Contents/MacOS/runtime-raiders-agent",
                isDirectory: false
            )
        )
    }

    func testFlatCommandRoutingUsesEmployeeStatusHelpAndStableDaemonControlRoutes() {
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-flat-routing")
        )
        let stableExecutable = paths.agentExecutable
        let otherExecutable = URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent")

        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: [],
                executableURL: otherExecutable,
                paths: paths
            ),
            .status(.pretty)
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["status"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .status(.pretty)
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["status", "--json"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .status(.json)
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["help"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .help
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["--help"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .help
        )
        XCTAssertNil(CompanionCommandRouter.route(
            arguments: ["status", "--pretty"],
            executableURL: otherExecutable,
            paths: paths
        ))
        XCTAssertNil(CompanionCommandRouter.route(
            arguments: ["status", "--json", "extra"],
            executableURL: otherExecutable,
            paths: paths
        ))
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: stableExecutable,
                paths: paths
            ),
            .daemon
        )
        XCTAssertNil(CompanionCommandRouter.route(
            arguments: ["daemon"],
            executableURL: otherExecutable,
            paths: paths
        ))
        for action in [
            ManagedAgentAction.register,
            .unregister,
            .status,
        ] {
            XCTAssertEqual(
                CompanionCommandRouter.route(
                    arguments: ["__runtime-raiders-managed-agent", action.rawValue],
                    executableURL: stableExecutable,
                    paths: paths
                ),
                .managedAgent(action)
            )
            XCTAssertNil(CompanionCommandRouter.route(
                arguments: ["__runtime-raiders-managed-agent", action.rawValue],
                executableURL: otherExecutable,
                paths: paths
            ))
        }
        for arguments in [
            ["__runtime-raiders-managed-agent"],
            ["__runtime-raiders-managed-agent", "unknown"],
            ["__runtime-raiders-managed-agent", "status", "extra"],
        ] {
            XCTAssertNil(CompanionCommandRouter.route(
                arguments: arguments,
                executableURL: stableExecutable,
                paths: paths
            ))
        }
        for command in [
            ControlCommand.on,
            .off,
            .doctor,
        ] {
            XCTAssertEqual(
                CompanionCommandRouter.route(
                    arguments: [command.rawValue],
                    executableURL: otherExecutable,
                    paths: paths
                ),
                .control(command)
            )
        }
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["update"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .updateCheck
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["re-enroll"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .reEnroll
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["uninstall"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .uninstall(.preserveState)
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["uninstall", "--everything"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .uninstall(.everything)
        )
        for arguments in [
            ["re-enroll", "synthetic-code"],
            ["re-enroll", "--code", "synthetic-code"],
            ["uninstall", "--all"],
            ["uninstall", "everything"],
            ["uninstall", "--everything", "extra"],
        ] {
            XCTAssertNil(
                CompanionCommandRouter.route(
                    arguments: arguments,
                    executableURL: otherExecutable,
                    paths: paths
                ),
                "accepted lifecycle alias or argv input \(arguments)"
            )
        }

        let retiredPrepare = ["prepare", "update"].joined(separator: "_")
        let retiredResume = ["resume", "update"].joined(separator: "_")
        for arguments in [
            [retiredPrepare],
            [retiredResume],
            ["__self-check"],
            ["__runtime-raiders-register-application"],
            ["__runtime-raiders-installer-lease"],
            ["__runtime-raiders-legacy-prepare"],
            ["__runtime-raiders-installer-validate-legacy"],
            ["__runtime-raiders-installer-retire-sequence-eight-command"],
            ["__runtime-raiders-installer-status", "legacy-running"],
            ["__runtime-raiders-installer-protected-state"],
            ["__runtime-raiders-installer-sync-migration", "candidate"],
            ["__runtime-raiders-legacy-resume"],
            ["__runtime-raiders-installer-resume", "1"],
            ["daemon", "__runtime-raiders-trial-generation", "1"],
            ["daemon", "__runtime-raiders-installer-migration-generation", "1"],
        ] {
            XCTAssertNil(
                CompanionCommandRouter.route(
                    arguments: arguments,
                    executableURL: stableExecutable,
                    paths: paths
                ),
                "accepted retired route \(arguments)"
            )
        }
    }

    func testOutputStyleUsesANSIOnlyForInteractiveOutputWithoutNoColor() {
        XCTAssertEqual(outputStyle(isTTY: true, environment: [:]), .ansi)
        XCTAssertEqual(outputStyle(isTTY: false, environment: [:]), .plain)
        XCTAssertEqual(outputStyle(isTTY: true, environment: ["NO_COLOR": ""]), .plain)
        XCTAssertEqual(outputStyle(isTTY: false, environment: ["NO_COLOR": "1"]), .plain)
    }

    func testLifecycleTerminalReaderUsesPrivateTTYAndRestoresEchoAfterBoundedRead() throws {
        try withPseudoTerminal { master, path in
            let secret = "synthetic-redacted-code"
            let result = TerminalReadResult()
            DispatchQueue.global().async {
                result.start()
                result.finish(Result {
                    try LifecycleTerminalReader(path: path).readLine(
                        prompt: "Enrollment code: ",
                        maximumBytes: 64
                    )
                })
            }
            XCTAssertTrue(result.started.wait(timeout: .now() + 1) == .success)
            var terminalOutput = ""
            for _ in 0..<100 {
                terminalOutput += readAvailable(master)
                if terminalOutput.contains("Enrollment code: ") { break }
                Darwin.usleep(10_000)
            }
            XCTAssertTrue(terminalOutput.contains("Enrollment code: "))
            try writeAll(Data((secret + "\n").utf8), to: master)

            XCTAssertEqual(try result.value(), secret)
            XCTAssertTrue(terminalEchoEnabled(at: path))
            XCTAssertFalse((terminalOutput + readAvailable(master)).contains(secret))
        }
    }

    func testLifecycleTerminalReaderEnforcesCodeChoiceAndConfirmationByteBounds() throws {
        for (maximumBytes, acceptedCount) in [(64, 64), (32, 32), (64, 64)] {
            try withPseudoTerminal { master, path in
                let result = startTerminalRead(path: path, maximumBytes: maximumBytes)
                try waitForPrompt("Private input: ", from: master)
                try writeAll(Data((String(repeating: "a", count: acceptedCount) + "\n").utf8), to: master)
                XCTAssertEqual(try result.value().utf8.count, acceptedCount)
                XCTAssertTrue(terminalEchoEnabled(at: path))
            }
        }

        for maximumBytes in [64, 32] {
            try withPseudoTerminal { master, path in
                let result = startTerminalRead(path: path, maximumBytes: maximumBytes)
                try waitForPrompt("Private input: ", from: master)
                try writeAll(
                    Data((String(repeating: "b", count: maximumBytes + 1) + "\n").utf8),
                    to: master
                )
                XCTAssertThrowsError(try result.value())
                XCTAssertTrue(terminalEchoEnabled(at: path))
            }
        }
    }

    func testLifecycleTerminalReaderDrainsOversizedPrivateRecordBeforeReturning() throws {
        try withPseudoTerminal { master, path in
            let heldSlave = Darwin.open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
            guard heldSlave >= 0 else { throw POSIXError(.EIO) }
            defer { Darwin.close(heldSlave) }
            let oversized = String(repeating: "s", count: 96)
            let first = startTerminalRead(path: path, maximumBytes: 32)
            try waitForPrompt("Private input: ", from: master)
            try writeAll(Data((oversized + "\nNEXT\n").utf8), to: master)

            XCTAssertThrowsError(try first.value()) { error in
                XCTAssertEqual(error as? LifecycleTerminalError, .invalidInput)
            }
            XCTAssertTrue(terminalEchoEnabled(at: path))

            let second = startTerminalRead(path: path, maximumBytes: 32)
            try waitForPrompt("Private input: ", from: master)
            XCTAssertEqual(try second.value(), "NEXT")
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testLifecycleTerminalReaderProtectsSignalsAcrossBothEchoTransitionWindows() throws {
        try withPseudoTerminal { _, path in
            let protectionInstalled = DispatchSemaphore(value: 0)
            let echoRestored = DispatchSemaphore(value: 0)
            let reader = LifecycleTerminalReader(
                testPath: path,
                transitionHook: { transition in
                    switch transition {
                    case .signalProtectionInstalled: protectionInstalled.signal()
                    case .echoRestored: echoRestored.signal()
                    case .signalHandlersRestoring: return
                    }
                    _ = Darwin.raise(SIGINT)
                }
            )

            XCTAssertThrowsError(
                try reader.readLine(prompt: "Private input: ", maximumBytes: 64)
            ) { error in
                XCTAssertEqual(error as? LifecycleTerminalError, .interrupted)
            }
            XCTAssertEqual(protectionInstalled.wait(timeout: .now()), .success)
            XCTAssertEqual(echoRestored.wait(timeout: .now()), .success)
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testLifecycleTerminalReaderCancelsValidInputWhenSignalArrivesAfterEchoRestore() throws {
        for protectedSignal in [SIGINT, SIGTERM] {
            try withPseudoTerminal { master, path in
                let writer = TerminalReadResult()
                let reader = LifecycleTerminalReader(
                    testPath: path,
                    transitionHook: { transition in
                        guard transition == .echoRestored else { return }
                        _ = Darwin.raise(protectedSignal)
                    }
                )
                DispatchQueue.global().async {
                    writer.start()
                    writer.finish(Result {
                        try waitForPrompt("Private input: ", from: master)
                        try writeAll(Data("CONFIRM\n".utf8), to: master)
                        return "written"
                    })
                }
                XCTAssertTrue(writer.started.wait(timeout: .now() + 1) == .success)

                XCTAssertThrowsError(
                    try reader.readLine(prompt: "Private input: ", maximumBytes: 64)
                ) { error in
                    XCTAssertEqual(error as? LifecycleTerminalError, .interrupted)
                }
                XCTAssertEqual(try writer.value(), "written")
                XCTAssertTrue(terminalEchoEnabled(at: path))
            }
        }
    }

    func testLifecycleTerminalReaderFailsClosedAndDeliversSignalFromFinalRestorationWindow() throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(Darwin.pipe(&descriptors), 0)
        let readDescriptor = descriptors[0]
        let writeDescriptor = descriptors[1]
        defer {
            lifecycleRestorationSignalWriteDescriptor = -1
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
        }
        let readFlags = Darwin.fcntl(readDescriptor, F_GETFL)
        XCTAssertGreaterThanOrEqual(readFlags, 0)
        XCTAssertEqual(Darwin.fcntl(readDescriptor, F_SETFL, readFlags | O_NONBLOCK), 0)

        lifecycleRestorationSignalWriteDescriptor = writeDescriptor
        let previousHandler = Darwin.signal(SIGQUIT, lifecycleRestorationPriorSignalHandler)
        defer { _ = Darwin.signal(SIGQUIT, previousHandler) }

        try withPseudoTerminal { master, path in
            let writer = TerminalReadResult()
            let reader = LifecycleTerminalReader(
                testPath: path,
                transitionHook: { transition in
                    guard transition == .signalHandlersRestoring else { return }
                    _ = Darwin.raise(SIGQUIT)
                }
            )
            DispatchQueue.global().async {
                writer.start()
                writer.finish(Result {
                    try waitForPrompt("Private input: ", from: master)
                    try writeAll(Data("CONFIRM\n".utf8), to: master)
                    return "written"
                })
            }
            XCTAssertEqual(writer.started.wait(timeout: .now() + 1), .success)

            XCTAssertThrowsError(
                try reader.readLine(prompt: "Private input: ", maximumBytes: 64)
            ) { error in
                XCTAssertEqual(error as? LifecycleTerminalError, .interrupted)
            }
            XCTAssertEqual(try writer.value(), "written")
            XCTAssertEqual(waitForSignalByte(from: readDescriptor), UInt8(SIGQUIT))
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testLifecycleTerminalReaderFailsClosedForCompletedCrossThreadTemporaryHandler() throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(Darwin.pipe(&descriptors), 0)
        let readDescriptor = descriptors[0]
        let writeDescriptor = descriptors[1]
        defer {
            lifecycleRestorationSignalWriteDescriptor = -1
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
        }
        let readFlags = Darwin.fcntl(readDescriptor, F_GETFL)
        XCTAssertGreaterThanOrEqual(readFlags, 0)
        XCTAssertEqual(Darwin.fcntl(readDescriptor, F_SETFL, readFlags | O_NONBLOCK), 0)

        lifecycleRestorationSignalWriteDescriptor = writeDescriptor
        let previousHandler = Darwin.signal(SIGQUIT, lifecycleRestorationPriorSignalHandler)
        defer { _ = Darwin.signal(SIGQUIT, previousHandler) }

        let workerReady = DispatchSemaphore(value: 0)
        let deliverSignal = DispatchSemaphore(value: 0)
        let handlerDeliveryCompleted = DispatchSemaphore(value: 0)
        let worker = Thread {
            var signalSet = sigset_t()
            _ = Darwin.sigemptyset(&signalSet)
            _ = Darwin.sigaddset(&signalSet, SIGQUIT)
            _ = Darwin.pthread_sigmask(SIG_UNBLOCK, &signalSet, nil)
            workerReady.signal()
            deliverSignal.wait()
            _ = Darwin.raise(SIGQUIT)
            handlerDeliveryCompleted.signal()
        }
        worker.start()
        defer { deliverSignal.signal() }
        XCTAssertEqual(workerReady.wait(timeout: .now() + 1), .success)

        try withPseudoTerminal { master, path in
            let writer = TerminalReadResult()
            let reader = LifecycleTerminalReader(
                testPath: path,
                transitionHook: { transition in
                    guard transition == .signalHandlersRestoring else { return }
                    deliverSignal.signal()
                    XCTAssertEqual(
                        handlerDeliveryCompleted.wait(timeout: .now() + 1),
                        .success
                    )
                }
            )
            DispatchQueue.global().async {
                writer.start()
                writer.finish(Result {
                    try waitForPrompt("Private input: ", from: master)
                    try writeAll(Data("CONFIRM\n".utf8), to: master)
                    return "written"
                })
            }
            XCTAssertEqual(writer.started.wait(timeout: .now() + 1), .success)

            XCTAssertThrowsError(
                try reader.readLine(prompt: "Private input: ", maximumBytes: 64)
            ) { error in
                XCTAssertEqual(error as? LifecycleTerminalError, .interrupted)
            }
            XCTAssertEqual(try writer.value(), "written")
            XCTAssertNil(readSignalByte(from: readDescriptor))
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testLifecycleTerminalReaderWaitsForEnteredHandlerBeforeFinalDrain() throws {
        try assertLifecycleHandlerHandoff(
            pauseStage: RRS_TEST_PAUSE_AFTER_CLAIM,
            expectsPriorDelivery: false
        )
    }

    func testLifecycleTerminalReaderForwardsEnteredHandlerThatObservesClosedGate() throws {
        try assertLifecycleHandlerHandoff(
            pauseStage: RRS_TEST_PAUSE_BEFORE_CLAIM,
            expectsPriorDelivery: true
        )
    }

    func testLifecycleSignalSupportPreservesErrnoAndFailsClosedWhenPipeIsFull() throws {
        let fullPipe = try descriptorPipe()
        let nextPipe = try descriptorPipe()
        defer {
            Darwin.close(fullPipe.read)
            Darwin.close(fullPipe.write)
            Darwin.close(nextPipe.read)
            Darwin.close(nextPipe.write)
        }
        let writeFlags = Darwin.fcntl(fullPipe.write, F_GETFL)
        XCTAssertGreaterThanOrEqual(writeFlags, 0)
        XCTAssertEqual(Darwin.fcntl(fullPipe.write, F_SETFL, writeFlags | O_NONBLOCK), 0)
        var filler: UInt8 = 0xA5
        while Darwin.write(fullPipe.write, &filler, 1) == 1 {}
        XCTAssertTrue(errno == EAGAIN || errno == EWOULDBLOCK)

        XCTAssertTrue(rrs_terminal_signal_trap_install(fullPipe.write))
        errno = ERANGE
        let firstRaiseResult = Darwin.raise(SIGQUIT)
        let errnoAfterFullPipeHandler = errno
        var sawDeliveryFailure = false
        XCTAssertTrue(rrs_terminal_signal_trap_restore(&sawDeliveryFailure))
        XCTAssertEqual(firstRaiseResult, 0)
        XCTAssertEqual(errnoAfterFullPipeHandler, ERANGE)
        XCTAssertTrue(sawDeliveryFailure)

        XCTAssertTrue(rrs_terminal_signal_trap_install(nextPipe.write))
        errno = EDOM
        let secondRaiseResult = Darwin.raise(SIGQUIT)
        let errnoAfterNextHandler = errno
        var sawSecondFailure = false
        XCTAssertTrue(rrs_terminal_signal_trap_restore(&sawSecondFailure))
        XCTAssertEqual(secondRaiseResult, 0)
        XCTAssertEqual(errnoAfterNextHandler, EDOM)
        XCTAssertFalse(sawSecondFailure)
        XCTAssertEqual(readDescriptorByte(nextPipe.read), UInt8(SIGQUIT))
    }

    func testLifecycleSignalSupportRollsBackPartialInstallationBeforeReuse() throws {
        let priorDelivery = try descriptorPipe()
        let signalPipe = try descriptorPipe()
        defer {
            Darwin.close(priorDelivery.read)
            Darwin.close(priorDelivery.write)
            Darwin.close(signalPipe.read)
            Darwin.close(signalPipe.write)
        }
        lifecycleRestorationSignalWriteDescriptor = priorDelivery.write
        let previousHandler = Darwin.signal(SIGINT, lifecycleRestorationPriorSignalHandler)
        defer {
            rrs_terminal_signal_test_reset()
            lifecycleRestorationSignalWriteDescriptor = -1
            _ = Darwin.signal(SIGINT, previousHandler)
        }

        rrs_terminal_signal_test_fail_install_at(2)
        XCTAssertFalse(rrs_terminal_signal_trap_install(signalPipe.write))
        rrs_terminal_signal_test_fail_install_at(-1)
        XCTAssertEqual(Darwin.raise(SIGINT), 0)
        XCTAssertEqual(readDescriptorByte(priorDelivery.read), UInt8(SIGINT))

        XCTAssertTrue(rrs_terminal_signal_trap_install(signalPipe.write))
        XCTAssertEqual(Darwin.raise(SIGQUIT), 0)
        var sawFailure = false
        XCTAssertTrue(rrs_terminal_signal_trap_restore(&sawFailure))
        XCTAssertFalse(sawFailure)
        XCTAssertEqual(readDescriptorByte(signalPipe.read), UInt8(SIGQUIT))
    }

    func testLifecycleTerminalReaderRejectsEmptyInvalidUTF8AndNonCharacterDevice() throws {
        for input in [Data([0x0A]), Data([0xFF, 0x0A])] {
            try withPseudoTerminal { master, path in
                let result = startTerminalRead(path: path, maximumBytes: 64)
                try waitForPrompt("Private input: ", from: master)
                try writeAll(input, to: master)
                XCTAssertThrowsError(try result.value())
                XCTAssertTrue(terminalEchoEnabled(at: path))
            }
        }
        XCTAssertThrowsError(
            try LifecycleTerminalReader(path: "/dev/null").readLine(
                prompt: "Code: ",
                maximumBytes: 64
            )
        )
    }

    func testLifecycleTerminalReaderRestoresEchoAfterTerminalWriteFailure() throws {
        try withPseudoTerminal { _, path in
            let reader = LifecycleTerminalReader(
                testPath: path,
                writeBytes: { _, _, _ in
                    errno = EIO
                    return -1
                }
            )

            XCTAssertThrowsError(try reader.readLine(prompt: "Private input: ", maximumBytes: 64))
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testLifecycleTerminalReaderFailsClosedWhenTerminalAttributesCannotBeControlled() throws {
        try withPseudoTerminal { _, path in
            let reader = LifecycleTerminalReader(
                testPath: path,
                setAttributes: { _, _, _ in
                    errno = ENOTTY
                    return -1
                }
            )

            XCTAssertThrowsError(try reader.readLine(prompt: "Private input: ", maximumBytes: 64))
            XCTAssertTrue(terminalEchoEnabled(at: path))
        }
    }

    func testNormalDaemonStartupStartsControlBeforeOptionalActivationAndVersionCheck() throws {
        var actions: [String] = []
        let enabledStartup = NormalDaemonStartupCoordinator(operations: DaemonStartupOperations(
            startControl: { actions.append("control") },
            prepareLocalState: { actions.append("local-state") },
            activatePersistedEnabled: { actions.append("activate") },
            scheduleVersionCheck: { actions.append("version-check") }
        ))

        try enabledStartup.start(persistedEnabled: true)

        XCTAssertEqual(actions, ["control", "local-state", "activate", "version-check"])

        actions.removeAll()
        let disabledStartup = NormalDaemonStartupCoordinator(operations: DaemonStartupOperations(
            startControl: { actions.append("control") },
            prepareLocalState: { actions.append("local-state") },
            activatePersistedEnabled: { actions.append("activate") },
            scheduleVersionCheck: { actions.append("version-check") }
        ))

        try disabledStartup.start(persistedEnabled: false)

        XCTAssertEqual(actions, ["control", "local-state", "version-check"])
    }

    func testVersionCheckSchedulerChecksImmediatelyRepeatsHourlyAndCancelsShutdownTimer() throws {
        let harness = VersionCheckScheduleHarness()
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: { harness.check() },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()

        XCTAssertEqual(harness.checkCount, 0)
        XCTAssertEqual(harness.enqueuedActionCount, 1)
        XCTAssertEqual(harness.delays, [60 * 60])

        try harness.enqueuedAction(at: 0)()
        XCTAssertEqual(harness.checkCount, 1)

        let firstOpportunity = try harness.action(at: 0)
        firstOpportunity()

        XCTAssertEqual(harness.checkCount, 1)
        XCTAssertEqual(harness.enqueuedActionCount, 2)
        XCTAssertEqual(harness.delays, [60 * 60, 60 * 60])

        try harness.enqueuedAction(at: 1)()
        XCTAssertEqual(harness.checkCount, 2)

        let shutdownTimer = try harness.action(at: 1)
        scheduler.stop()

        XCTAssertEqual(harness.cancelledTimerIDs, [1])
        shutdownTimer()
        XCTAssertEqual(harness.checkCount, 2)
        XCTAssertEqual(harness.delays, [60 * 60, 60 * 60])
    }

    func testVersionCheckSchedulerEnqueuesStartupCheckWithoutRunningInline() throws {
        let harness = VersionCheckScheduleHarness()
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: { harness.check() },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()

        XCTAssertEqual(harness.checkCount, 0)
        XCTAssertEqual(harness.enqueuedActionCount, 1)

        scheduler.stop()
        try harness.enqueuedAction(at: 0)()
        XCTAssertEqual(harness.checkCount, 0)
    }

    func testVersionCheckSchedulerStopWaitsForInFlightCheckBeforeReturning() throws {
        let checkStarted = DispatchSemaphore(value: 0)
        let allowCheckToFinish = DispatchSemaphore(value: 0)
        let checkFinished = DispatchSemaphore(value: 0)
        let cancellationStarted = DispatchSemaphore(value: 0)
        let allowCancellationToFinish = DispatchSemaphore(value: 0)
        let stopReturned = DispatchSemaphore(value: 0)
        let harness = VersionCheckScheduleHarness { _ in
            cancellationStarted.signal()
            allowCancellationToFinish.wait()
        }
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: {
                    checkStarted.signal()
                    allowCheckToFinish.wait()
                    checkFinished.signal()
                },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()
        let startupCheck = try harness.enqueuedAction(at: 0)
        DispatchQueue(label: "version-check-test.check").async(execute: startupCheck)
        XCTAssertEqual(checkStarted.wait(timeout: .now() + 1), .success)

        DispatchQueue(label: "version-check-test.stop").async {
            scheduler.stop()
            stopReturned.signal()
        }
        XCTAssertEqual(cancellationStarted.wait(timeout: .now() + 1), .success)
        allowCancellationToFinish.signal()

        XCTAssertEqual(stopReturned.wait(timeout: .now() + 0.2), .timedOut)
        allowCheckToFinish.signal()
        XCTAssertEqual(checkFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(stopReturned.wait(timeout: .now() + 1), .success)
    }

    func testAgentStatusWireIncludesActivationStateWithoutRemovingEnabled() throws {
        let status = AgentStatus(
            enabled: true,
            activationState: .preparing,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop],
            compiledAdapters: [.codexDesktop: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: nil,
            activeRunCount: 0
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(status.description.utf8))
                as? [String: Any]
        )

        XCTAssertEqual(object["enabled"] as? Bool, true)
        XCTAssertEqual(object["activationState"] as? String, "preparing")
        XCTAssertEqual(object["laggingProviderFileCount"] as? Int, 0)
        XCTAssertEqual(object["providerLagBytes"] as? Int, 0)
        XCTAssertNil(object["availableReleaseSequence"])
        XCTAssertNil(object["installedReleaseSequence"])
        XCTAssertNil(object["preparedForUpdate"])
        XCTAssertNil(object["preparedReleaseStateGeneration"])
    }

    func testDoctorRequestCarriesOnlyKnownInvocationEnvironmentPresence() throws {
        let request = ControlRequest.invocation(
            command: .doctor,
            environment: [
                "OTEL_EXPORTER_OTLP_HEADERS": "DO_NOT_EXPORT_SECRET_VALUE",
                "ARBITRARY_ENVIRONMENT_KEY": "DO_NOT_EXPORT_ARBITRARY_VALUE",
            ]
        )

        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let rendered = try XCTUnwrap(String(data: frame, encoding: .utf8))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), ["command", "claude_otel_environment_present"])
        XCTAssertEqual(object["command"] as? String, "doctor")
        XCTAssertEqual(object["claude_otel_environment_present"] as? Bool, true)
        XCTAssertFalse(rendered.contains("OTEL_EXPORTER_OTLP_HEADERS"))
        XCTAssertFalse(rendered.contains("ARBITRARY_ENVIRONMENT_KEY"))
        XCTAssertFalse(rendered.contains("DO_NOT_EXPORT"))
        XCTAssertEqual(
            try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
            request
        )
    }

    func testPublicNonDoctorCommandsRoundTripWithoutInternalMetadata() throws {
        for command in ControlCommand.allCases where command != .doctor {
            let request = ControlRequest.invocation(
                command: command,
                environment: ["CLAUDE_CODE_ENABLE_TELEMETRY": "DO_NOT_EXPORT_VALUE"]
            )
            let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
            )

            XCTAssertEqual(Set(object.keys), ["command"])
            XCTAssertNil(request.claudeOTelEnvironmentPresent)
            XCTAssertEqual(
                try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
                request
            )
        }
    }

    func testProtocolRejectsMalformedExtraAndCommandInconsistentFields() {
        let retiredPrepare = ["prepare", "update"].joined(separator: "_")
        let retiredResume = ["resume", "update"].joined(separator: "_")
        let invalidFrames: [Data] = [
            Data("status\n".utf8),
            Data(#"{"command":"doctor"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"status","claude_otel_environment_present":false}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":"true"}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":false,"extra":true}"#.utf8)
                + Data([0x0A]),
            Data("{\"command\":\"\(retiredPrepare)\"}".utf8) + Data([0x0A]),
            Data("{\"command\":\"\(retiredResume)\"}".utf8) + Data([0x0A]),
            Data("{\"command\":\"\(retiredPrepare)\",\"release_state_generation\":0}".utf8)
                + Data([0x0A]),
            Data("{\"command\":\"\(retiredResume)\",\"release_state_generation\":9007199254740992}".utf8)
                + Data([0x0A]),
            Data(#"{"command":"status","release_state_generation":7}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"unknown"}"#.utf8) + Data([0x0A]),
            Data("[]\n".utf8),
        ]

        for frame in invalidFrames {
            XCTAssertThrowsError(
                try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
                String(decoding: frame, as: UTF8.self)
            )
        }
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .doctor),
                maximumFrameBytes: 4_096
            )
        )
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .status, claudeOTelEnvironmentPresent: true),
                maximumFrameBytes: 4_096
            )
        )
    }

    func testKnownEnvironmentDetectionIgnoresValuesAndArbitraryNames() {
        for name in [
            "CLAUDE_CODE_ENABLE_TELEMETRY",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
        ] {
            XCTAssertTrue(DoctorEnvironment.claudeOTelPresent(in: [name: ""]))
            XCTAssertTrue(DoctorEnvironment.claudeOTelPresent(in: [name: "DO_NOT_EXPORT"]))
        }
        XCTAssertFalse(DoctorEnvironment.claudeOTelPresent(in: [:]))
        XCTAssertFalse(DoctorEnvironment.claudeOTelPresent(in: [
            "OTEL_UNRELATED_VARIABLE": "DO_NOT_EXPORT",
            "CLAUDE_UNRELATED_VARIABLE": "DO_NOT_EXPORT",
        ]))
        XCTAssertTrue(DoctorEnvironment.combinedPresence(
            invocationPresent: true,
            daemonEnvironment: [:]
        ))
        XCTAssertTrue(DoctorEnvironment.combinedPresence(
            invocationPresent: false,
            daemonEnvironment: ["OTEL_LOGS_EXPORTER": "DO_NOT_EXPORT"]
        ))
        XCTAssertFalse(DoctorEnvironment.combinedPresence(
            invocationPresent: false,
            daemonEnvironment: ["OTEL_UNRELATED_VARIABLE": "DO_NOT_EXPORT"]
        ))
    }

    func testSocketPassesTypedDoctorPresenceToRequestHandler() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-doctor-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { request in
            ControlResponse(
                ok: true,
                message: request.claudeOTelEnvironmentPresent == true ? "present" : "absent"
            )
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .doctor, claudeOTelEnvironmentPresent: true),
            to: socketURL
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "present"))
    }

    func testDoctorWaitsLongerThanItsBoundedServerHealthProbe() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-doctor-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { request in
            XCTAssertEqual(request.command, .doctor)
            Thread.sleep(forTimeInterval: 2.25)
            return ControlResponse(ok: true, message: "server health unavailable")
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .doctor, claudeOTelEnvironmentPresent: false),
            to: socketURL
        )

        XCTAssertEqual(
            response,
            ControlResponse(ok: true, message: "server health unavailable")
        )
    }

    func testAttestedSocketResponseReportsTheActualServingExecutable() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-attested-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { _ in ControlResponse(ok: true, message: "status") }
        defer { server.stop() }

        let (response, peer) = try ControlSocketClient.sendAttested(
            request: ControlRequest(command: .status),
            to: socketURL
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "status"))
        XCTAssertEqual(
            peer.executableURL.resolvingSymlinksInPath().standardizedFileURL.path,
            try XCTUnwrap(Bundle.main.executableURL)
                .resolvingSymlinksInPath().standardizedFileURL.path
        )
        XCTAssertEqual(peer.auditToken.count, MemoryLayout<audit_token_t>.size)
    }

    func testOnCrossesInitialTimeoutThroughSerializedReadinessBarrier() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = ControlActionLog()
        let enabledStatus = AgentStatus(
            enabled: true,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop, .codexCLI],
            compiledAdapters: [.codexDesktop: .available, .codexCLI: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: nil,
            activeRunCount: 0
        )
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: enabledStatus.description)
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "ready"))
        XCTAssertEqual(commands.values, ["on", "status"])
    }

    func testTimedOutOnFailsClosedWhenEnabledStatusHasDisabledActivation() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-disabled-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = ControlActionLog()
        let incoherentStatus = AgentStatus(
            enabled: true,
            activationState: .disabled,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop, .codexCLI],
            compiledAdapters: [.codexDesktop: .available, .codexCLI: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: nil,
            activeRunCount: 0
        )
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: incoherentStatus.description)
            case .off:
                return ControlResponse(ok: true, message: "disabled")
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )

        XCTAssertEqual(response, ControlResponse(ok: false, message: "unable to enable"))
        XCTAssertEqual(commands.values, ["on", "status", "off"])
    }

    func testTimedOutOnFailsClosedWhenReadinessBarrierIsInconclusive() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-inconclusive-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = ControlActionLog()
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: "not-agent-status")
            case .off:
                return ControlResponse(ok: true, message: "off")
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )

        XCTAssertEqual(response, ControlResponse(ok: false, message: "unable to enable"))
        XCTAssertEqual(commands.values, ["on", "status", "off"])
    }

    func testTimedOutOnNeverReportsFailureAsSafeWhenOffCannotBeVerified() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-unverified-off-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = ControlActionLog()
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: "not-agent-status")
            case .off:
                return ControlResponse(ok: false, message: "unable to turn off")
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        XCTAssertThrowsError(try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )) { error in
            XCTAssertEqual(error as? ControlSocketError, .enableCompletionUnverified)
        }
        XCTAssertEqual(commands.values, ["on", "status", "off"])
    }

    func testReEnrollmentInputMappingKeepsJournalUntilMalformedCodeRestoresOldAgent() throws {
        let state = try LifecycleInputRecoveryState()
        let base = makeLifecycleInputRecoveryOperations(state: state) {
            String(repeating: "x", count: 44)
        }
        let operations = base.mappingMalformedCodeToInvalidEnrollment { code in
            guard code.utf8.count == 43 else { throw EnrollmentClientError.invalidRequest }
        }

        XCTAssertEqual(
            try ReEnrollmentCoordinator(operations: operations).run(),
            .invalidEnrollment
        )
        XCTAssertEqual(state.journalWrites, [.replacementPrepared])
        XCTAssertEqual(state.replaceObservedJournal, .replacementPrepared)
        XCTAssertNil(state.journal)
        XCTAssertTrue(state.agentRegistered)
        XCTAssertEqual(state.journalRemovalCount, 1)
    }

    func testReEnrollmentInputMappingKeepsRecoveryJournalWhenCodePromptEnds() throws {
        let state = try LifecycleInputRecoveryState()
        let base = makeLifecycleInputRecoveryOperations(state: state) {
            throw LifecycleTerminalError.endOfFile
        }
        let operations = base.mappingMalformedCodeToInvalidEnrollment { _ in }

        XCTAssertThrowsError(try ReEnrollmentCoordinator(operations: operations).run())
        XCTAssertEqual(state.journalWrites, [.replacementPrepared])
        XCTAssertEqual(state.journal?.phase, .replacementPrepared)
        XCTAssertFalse(state.agentRegistered)
        XCTAssertEqual(state.journalRemovalCount, 0)
    }

    private func makeRecoveryPaths(_ suffix: String) throws -> AgentPaths {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-stable-recovery-\(suffix)-\(UUID().uuidString)", isDirectory: true)
        let paths = AgentPaths(applicationSupportDirectory: root)
        try FileManager.default.createDirectory(at: paths.supportDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.supportDirectory.path
        )
        return paths
    }

    private func makeRecoveryApp(_ app: URL, marker: String, mode: Int) throws {
        let executableDirectory = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: executableDirectory, withIntermediateDirectories: true)
        try Data(marker.utf8).write(to: app.appendingPathComponent("marker"))
        try Data("fixture".utf8).write(
            to: executableDirectory.appendingPathComponent("runtime-raiders-agent")
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: mode],
            ofItemAtPath: app.path
        )
    }

    private func recoveryPermissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func recoveryInode(_ url: URL) throws -> UInt64 {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
        return UInt64(metadata.st_ino)
    }

    private func recoveryMarker(_ app: URL) throws -> String {
        String(
            decoding: try Data(contentsOf: app.appendingPathComponent("marker")),
            as: UTF8.self
        )
    }
}

private final class LifecycleInputRecoveryLock: ReEnrollmentLock, @unchecked Sendable {}

private final class LifecycleInputRecoveryState: @unchecked Sendable {
    let oldEnrollment: EnrollmentConfiguration
    var agentRegistered = true
    var journal: RecoveryJournal?
    var journalWrites: [ReEnrollmentPhase] = []
    var replaceObservedJournal: ReEnrollmentPhase?
    var journalRemovalCount = 0

    init() throws {
        oldEnrollment = try EnrollmentConfiguration(
            deviceID: "00000000-0000-4000-8000-000000000011",
            deviceToken: String(repeating: "o", count: 43),
            dedupeSecret: Data(repeating: 0x11, count: 32),
            serverURL: URL(string: "https://raiders.redlattice.com")!,
            cutoverAtMS: 1,
            enabledSurfaces: [.codexCLI]
        )
    }
}

private func makeLifecycleInputRecoveryOperations(
    state: LifecycleInputRecoveryState,
    requestCode: @escaping () throws -> String
) -> ReEnrollmentOperations {
    ReEnrollmentOperations(
        companionVersion: "test",
        acquireLock: { LifecycleInputRecoveryLock() },
        loadJournal: { nil },
        readEnrollment: { state.oldEnrollment },
        proveCollectionOff: { true },
        unregisterAgent: { state.agentRegistered = false },
        verifyAgentUnregistered: { !state.agentRegistered },
        countQueue: { 0 },
        summarize: { _ in },
        confirmReEnrollment: { true },
        resolveQueue: { _ in .cancel },
        deliverQueue: { _ in },
        discardQueue: {},
        generateMaterial: {
            ReplacementMaterial(
                operationID: UUID(uuidString: "00000000-0000-4000-8000-000000000012")!,
                deviceID: UUID(uuidString: "00000000-0000-4000-8000-000000000013")!,
                deviceToken: String(repeating: "n", count: 43)
            )
        },
        writeJournal: {
            state.journal = $0
            state.journalWrites.append($0.phase)
        },
        requestCode: requestCode,
        replace: { _, _, _, _ in
            state.replaceObservedJournal = state.journal?.phase
            throw EnrollmentClientError.invalidRequest
        },
        recover: { _ in nil },
        persistEnrollment: { _ in },
        resetCollector: { _ in },
        registerAgent: { state.agentRegistered = true },
        verifyEnrollmentAndOff: { expected, _ in
            expected == state.oldEnrollment && state.agentRegistered
        },
        delayMilliseconds: { _ in },
        removeJournal: {
            state.journal = nil
            state.journalRemovalCount += 1
        }
    )
}

@_silgen_name("openpty")
private func openPseudoTerminal(
    _ master: UnsafeMutablePointer<Int32>,
    _ slave: UnsafeMutablePointer<Int32>,
    _ name: UnsafeMutablePointer<CChar>?,
    _ termp: UnsafeMutableRawPointer?,
    _ winp: UnsafeMutableRawPointer?
) -> Int32

private func withPseudoTerminal(
    _ body: (Int32, String) throws -> Void
) throws {
    var master: Int32 = -1
    var slave: Int32 = -1
    var name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard openPseudoTerminal(&master, &slave, &name, nil, nil) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer {
        Darwin.close(master)
        if slave >= 0 { Darwin.close(slave) }
    }
    var state = termios()
    guard Darwin.tcgetattr(slave, &state) == 0 else { throw POSIXError(.EIO) }
    state.c_lflag &= ~tcflag_t(ICANON)
    guard Darwin.tcsetattr(slave, TCSANOW, &state) == 0 else { throw POSIXError(.EIO) }
    Darwin.close(slave)
    slave = -1
    try body(
        master,
        String(decoding: name.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    )
}

private func terminalEchoEnabled(at path: String) -> Bool {
    let descriptor = Darwin.open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { return false }
    defer { Darwin.close(descriptor) }
    var state = termios()
    return Darwin.tcgetattr(descriptor, &state) == 0 && state.c_lflag & tcflag_t(ECHO) != 0
}

private func readAvailable(_ descriptor: Int32) -> String {
    _ = Darwin.fcntl(descriptor, F_SETFL, O_NONBLOCK)
    var bytes = [UInt8](repeating: 0, count: 512)
    let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
    guard count > 0 else { return "" }
    return String(decoding: bytes.prefix(Int(count)), as: UTF8.self)
}

private func waitForSignalByte(from descriptor: Int32) -> UInt8? {
    for _ in 0..<100 {
        var byte: UInt8 = 0
        if Darwin.read(descriptor, &byte, 1) == 1 { return byte }
        Darwin.usleep(10_000)
    }
    return nil
}

private func readSignalByte(from descriptor: Int32) -> UInt8? {
    var byte: UInt8 = 0
    return Darwin.read(descriptor, &byte, 1) == 1 ? byte : nil
}

private func assertLifecycleHandlerHandoff(
    pauseStage: rrs_test_pause_stage,
    expectsPriorDelivery: Bool
) throws {
    let entered = try descriptorPipe()
    let release = try descriptorPipe()
    let quiescence = try descriptorPipe()
    let quiescenceContinue = try descriptorPipe()
    let readerCompleted = try descriptorPipe()
    let workerCompleted = try descriptorPipe()
    let priorDelivery = try descriptorPipe()
    let allDescriptors = [
        entered.read, entered.write,
        release.read, release.write,
        quiescence.read, quiescence.write,
        quiescenceContinue.read, quiescenceContinue.write,
        readerCompleted.read, readerCompleted.write,
        workerCompleted.read, workerCompleted.write,
        priorDelivery.read, priorDelivery.write,
    ]
    defer { allDescriptors.forEach { Darwin.close($0) } }

    lifecycleRestorationSignalWriteDescriptor = priorDelivery.write
    let previousHandler = Darwin.signal(SIGQUIT, lifecycleRestorationPriorSignalHandler)
    defer {
        rrs_terminal_signal_test_reset()
        lifecycleRestorationSignalWriteDescriptor = -1
        _ = Darwin.signal(SIGQUIT, previousHandler)
    }
    rrs_terminal_signal_test_configure(
        pauseStage,
        SIGQUIT,
        entered.write,
        release.read,
        quiescence.write,
        quiescenceContinue.read
    )

    let workerReady = DispatchSemaphore(value: 0)
    let deliverSignal = DispatchSemaphore(value: 0)
    Thread {
        var signalSet = sigset_t()
        _ = Darwin.sigemptyset(&signalSet)
        _ = Darwin.sigaddset(&signalSet, SIGQUIT)
        _ = Darwin.pthread_sigmask(SIG_UNBLOCK, &signalSet, nil)
        workerReady.signal()
        deliverSignal.wait()
        errno = EOVERFLOW
        _ = Darwin.raise(SIGQUIT)
        writeDescriptorByte(workerCompleted.write, errno == EOVERFLOW ? 1 : 0)
    }.start()
    XCTAssertEqual(workerReady.wait(timeout: .now() + 1), .success)

    try withPseudoTerminal { master, path in
        let writer = TerminalReadResult()
        let readerResult = TerminalReadResult()
        let reader = LifecycleTerminalReader(
            testPath: path,
            transitionHook: { transition in
                guard transition == .signalHandlersRestoring else { return }
                deliverSignal.signal()
                _ = readDescriptorByte(entered.read)
            }
        )
        DispatchQueue.global().async {
            readerResult.start()
            readerResult.finish(Result {
                try reader.readLine(prompt: "Private input: ", maximumBytes: 64)
            })
            writeDescriptorByte(readerCompleted.write, 1)
        }
        DispatchQueue.global().async {
            writer.start()
            writer.finish(Result {
                try waitForPrompt("Private input: ", from: master)
                try writeAll(Data("CONFIRM\n".utf8), to: master)
                return "written"
            })
        }
        XCTAssertEqual(readerResult.started.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(writer.started.wait(timeout: .now() + 1), .success)

        var observations = [
            pollfd(fd: readerCompleted.read, events: Int16(POLLIN), revents: 0),
            pollfd(fd: quiescence.read, events: Int16(POLLIN), revents: 0),
        ]
        XCTAssertEqual(Darwin.poll(&observations, 2, -1), 1)
        let reachedQuiescence = observations[1].revents & Int16(POLLIN) != 0
        if reachedQuiescence {
            _ = readDescriptorByte(quiescence.read)
        } else {
            _ = readDescriptorByte(readerCompleted.read)
        }

        writeDescriptorByte(release.write, 1)
        XCTAssertEqual(readDescriptorByte(workerCompleted.read), 1)
        let priorReadFlags = Darwin.fcntl(priorDelivery.read, F_GETFL)
        XCTAssertGreaterThanOrEqual(priorReadFlags, 0)
        XCTAssertEqual(
            Darwin.fcntl(priorDelivery.read, F_SETFL, priorReadFlags | O_NONBLOCK),
            0
        )
        let deliveredToPrior = readSignalByte(from: priorDelivery.read)
        if expectsPriorDelivery {
            XCTAssertEqual(deliveredToPrior, UInt8(SIGQUIT))
        } else {
            XCTAssertNil(deliveredToPrior)
        }
        if reachedQuiescence {
            writeDescriptorByte(quiescenceContinue.write, 1)
        }

        XCTAssertTrue(reachedQuiescence, "reader accepted input before handler handoff")
        XCTAssertThrowsError(try readerResult.value()) { error in
            XCTAssertEqual(error as? LifecycleTerminalError, .interrupted)
        }
        XCTAssertEqual(try writer.value(), "written")
        XCTAssertTrue(terminalEchoEnabled(at: path))
    }
}

private func descriptorPipe() throws -> (read: Int32, write: Int32) {
    var descriptors = [Int32](repeating: -1, count: 2)
    guard Darwin.pipe(&descriptors) == 0 else { throw POSIXError(.EIO) }
    return (descriptors[0], descriptors[1])
}

private func readDescriptorByte(_ descriptor: Int32) -> UInt8? {
    var byte: UInt8 = 0
    return Darwin.read(descriptor, &byte, 1) == 1 ? byte : nil
}

private func writeDescriptorByte(_ descriptor: Int32, _ byte: UInt8) {
    var byte = byte
    _ = Darwin.write(descriptor, &byte, 1)
}

private func startTerminalRead(path: String, maximumBytes: Int) -> TerminalReadResult {
    let result = TerminalReadResult()
    DispatchQueue.global().async {
        result.start()
        result.finish(Result {
            try LifecycleTerminalReader(path: path).readLine(
                prompt: "Private input: ",
                maximumBytes: maximumBytes
            )
        })
    }
    return result
}

private func waitForPrompt(_ prompt: String, from descriptor: Int32) throws {
    var output = ""
    for _ in 0..<100 {
        output += readAvailable(descriptor)
        if output.contains(prompt) { return }
        Darwin.usleep(10_000)
    }
    throw POSIXError(.ETIMEDOUT)
}

private func writeAll(_ data: Data, to descriptor: Int32) throws {
    let count = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
    guard count == data.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
}

private final class TerminalReadResult: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    private let completed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var stored: Result<String, Error>?

    func start() {
        started.signal()
    }

    func finish(_ result: Result<String, Error>) {
        lock.withLock { stored = result }
        completed.signal()
    }

    func value() throws -> String {
        guard completed.wait(timeout: .now() + 1) == .success else { throw POSIXError(.ETIMEDOUT) }
        return try lock.withLock { try stored!.get() }
    }
}

private final class ControlActionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] { lock.withLock { storage } }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
    }
}

private final class VersionCheckScheduleHarness: @unchecked Sendable {
    private let lock = NSLock()
    private let cancellationObserver: @Sendable (Int) -> Void
    private var checkCountStorage = 0
    private var delaysStorage: [TimeInterval] = []
    private var actionsStorage: [@Sendable () -> Void] = []
    private var enqueuedActionsStorage: [@Sendable () -> Void] = []
    private var cancelledTimerIDsStorage: [Int] = []

    var checkCount: Int { lock.withLock { checkCountStorage } }
    var delays: [TimeInterval] { lock.withLock { delaysStorage } }
    var cancelledTimerIDs: [Int] { lock.withLock { cancelledTimerIDsStorage } }
    var enqueuedActionCount: Int { lock.withLock { enqueuedActionsStorage.count } }

    init(cancellationObserver: @escaping @Sendable (Int) -> Void = { _ in }) {
        self.cancellationObserver = cancellationObserver
    }

    func check() {
        lock.withLock { checkCountStorage += 1 }
    }

    func enqueue(_ action: @escaping @Sendable () -> Void) {
        lock.withLock { enqueuedActionsStorage.append(action) }
    }

    func schedule(
        after delay: TimeInterval,
        action: @escaping @Sendable () -> Void
    ) -> ScheduledVersionCheck {
        let timerID = lock.withLock { () -> Int in
            let timerID = actionsStorage.count
            delaysStorage.append(delay)
            actionsStorage.append(action)
            return timerID
        }
        return ScheduledVersionCheck { [weak self] in
            self?.lock.withLock { self?.cancelledTimerIDsStorage.append(timerID) }
            self?.cancellationObserver(timerID)
        }
    }

    func action(at index: Int) throws -> @Sendable () -> Void {
        try lock.withLock {
            guard actionsStorage.indices.contains(index) else {
                throw POSIXError(.EINVAL)
            }
            return actionsStorage[index]
        }
    }

    func enqueuedAction(at index: Int) throws -> @Sendable () -> Void {
        try lock.withLock {
            guard enqueuedActionsStorage.indices.contains(index) else {
                throw POSIXError(.EINVAL)
            }
            return enqueuedActionsStorage[index]
        }
    }
}
