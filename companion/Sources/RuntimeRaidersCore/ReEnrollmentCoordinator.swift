import Foundation

public enum QueueDisposition: Equatable, Sendable {
    case deliver
    case discard
    case cancel
}

public enum ReEnrollmentOutcome: Equatable, Sendable {
    case completed
    case cancelled
    case collectionMustBeOff
    case invalidEnrollment
    case recoveryRequired
}

public protocol ReEnrollmentLock: AnyObject, Sendable {}

extension LifecycleLock: ReEnrollmentLock {}

public enum ReEnrollmentActionBoundary: CaseIterable, Equatable, Sendable {
    case lock
    case readEnrollment
    case proveCollectionOff
    case unregisterAgent
    case countQueue
    case summarize
    case confirmReEnrollment
    case resolveQueue
    case createJournal
    case requestCode
    case replace
    case delay
    case recoverNew
    case recoverOld
    case serverCommitted
    case persistNewConfiguration
    case configurationInstalled
    case resetCollector
    case collectorReset
    case registerAgent
    case agentRegistered
    case verifyNewConfigurationAndOff
    case deleteJournal
}

public struct ReEnrollmentOperations: @unchecked Sendable {
    public let companionVersion: String
    public let acquireLock: () throws -> any ReEnrollmentLock
    public let loadJournal: () throws -> RecoveryJournal?
    public let readEnrollment: () throws -> EnrollmentConfiguration
    public let proveCollectionOff: () throws -> Bool
    public let unregisterAgent: () throws -> Void
    public let countQueue: () throws -> Int
    public let summarize: (Int) throws -> Void
    public let confirmReEnrollment: () throws -> Bool
    public let resolveQueue: (Int) throws -> QueueDisposition
    public let deliverQueue: (EnrollmentConfiguration) throws -> Void
    public let discardQueue: () throws -> Void
    public let generateMaterial: () throws -> ReplacementMaterial
    public let writeJournal: (RecoveryJournal) throws -> Void
    public let requestCode: () throws -> String
    public let replace: (
        EnrollmentConfiguration,
        String,
        ReplacementMaterial,
        String
    ) throws -> ReplacementHTTPResult
    public let recover: (String) throws -> RecoveredEnrollment?
    public let persistEnrollment: (EnrollmentConfiguration) throws -> Void
    public let resetCollector: ([RunSurface]) throws -> Void
    public let registerAgent: () throws -> Void
    public let verifyEnrollmentAndOff: (EnrollmentConfiguration) throws -> Bool
    public let delayMilliseconds: (Int) throws -> Void
    public let removeJournal: () throws -> Void
    public let interruptionPoint: (ReEnrollmentActionBoundary) throws -> Void

    public init(
        companionVersion: String,
        acquireLock: @escaping () throws -> any ReEnrollmentLock,
        loadJournal: @escaping () throws -> RecoveryJournal?,
        readEnrollment: @escaping () throws -> EnrollmentConfiguration,
        proveCollectionOff: @escaping () throws -> Bool,
        unregisterAgent: @escaping () throws -> Void,
        countQueue: @escaping () throws -> Int,
        summarize: @escaping (Int) throws -> Void,
        confirmReEnrollment: @escaping () throws -> Bool,
        resolveQueue: @escaping (Int) throws -> QueueDisposition,
        deliverQueue: @escaping (EnrollmentConfiguration) throws -> Void,
        discardQueue: @escaping () throws -> Void,
        generateMaterial: @escaping () throws -> ReplacementMaterial,
        writeJournal: @escaping (RecoveryJournal) throws -> Void,
        requestCode: @escaping () throws -> String,
        replace: @escaping (
            EnrollmentConfiguration,
            String,
            ReplacementMaterial,
            String
        ) throws -> ReplacementHTTPResult,
        recover: @escaping (String) throws -> RecoveredEnrollment?,
        persistEnrollment: @escaping (EnrollmentConfiguration) throws -> Void,
        resetCollector: @escaping ([RunSurface]) throws -> Void,
        registerAgent: @escaping () throws -> Void,
        verifyEnrollmentAndOff: @escaping (EnrollmentConfiguration) throws -> Bool,
        delayMilliseconds: @escaping (Int) throws -> Void,
        removeJournal: @escaping () throws -> Void,
        interruptionPoint: @escaping (ReEnrollmentActionBoundary) throws -> Void = { _ in }
    ) {
        self.companionVersion = companionVersion
        self.acquireLock = acquireLock
        self.loadJournal = loadJournal
        self.readEnrollment = readEnrollment
        self.proveCollectionOff = proveCollectionOff
        self.unregisterAgent = unregisterAgent
        self.countQueue = countQueue
        self.summarize = summarize
        self.confirmReEnrollment = confirmReEnrollment
        self.resolveQueue = resolveQueue
        self.deliverQueue = deliverQueue
        self.discardQueue = discardQueue
        self.generateMaterial = generateMaterial
        self.writeJournal = writeJournal
        self.requestCode = requestCode
        self.replace = replace
        self.recover = recover
        self.persistEnrollment = persistEnrollment
        self.resetCollector = resetCollector
        self.registerAgent = registerAgent
        self.verifyEnrollmentAndOff = verifyEnrollmentAndOff
        self.delayMilliseconds = delayMilliseconds
        self.removeJournal = removeJournal
        self.interruptionPoint = interruptionPoint
    }

    public static func live(
        paths: CompanionLifecyclePaths,
        companionVersion: String,
        managedAgent: ManagedAgentServiceController = .live,
        outbox: Outbox,
        enrollmentClient: EnrollmentClient,
        uploadTransport: @escaping Uploader.Transport,
        credentialGenerator: SecureCredentialGenerator = SecureCredentialGenerator(),
        summarize: @escaping (Int) throws -> Void,
        confirmReEnrollment: @escaping () throws -> Bool,
        resolveQueue: @escaping (Int) throws -> QueueDisposition,
        requestCode: @escaping () throws -> String,
        delayMilliseconds: @escaping (Int) throws -> Void
    ) throws -> ReEnrollmentOperations {
        let journalStore = try RecoveryJournalStore(paths: paths)
        return ReEnrollmentOperations(
            companionVersion: companionVersion,
            acquireLock: { try LifecycleLock.acquire(at: paths.lifecycleLock) },
            loadJournal: { try journalStore.load() },
            readEnrollment: { try EnrollmentConfiguration.loadExisting(from: paths.enrollment) },
            proveCollectionOff: {
                let enrollment = try EnrollmentConfiguration.loadExisting(from: paths.enrollment)
                return try AgentController.persistedCollectorState(
                    paths: paths.agent,
                    surfaces: enrollment.enabledSurfaces
                ) == .disabled
            },
            unregisterAgent: {
                _ = try managedAgent.perform(.unregister)
            },
            countQueue: { try outbox.queuedCount() },
            summarize: summarize,
            confirmReEnrollment: confirmReEnrollment,
            resolveQueue: resolveQueue,
            deliverQueue: { enrollment in
                let delivery = try OneShotOutboxDelivery(
                    outbox: outbox,
                    configuration: UploadConfiguration(
                        origin: enrollment.serverURL,
                        deviceToken: enrollment.deviceToken
                    ),
                    transport: uploadTransport
                )
                _ = try delivery.drain()
                guard try outbox.queuedCount() == 0 else {
                    throw OneShotOutboxDeliveryError.deliveryFailed
                }
            },
            discardQueue: {
                _ = try outbox.discardAllValidated()
                guard try outbox.queuedCount() == 0 else {
                    throw OutboxError.invalidRecord
                }
            },
            generateMaterial: { try credentialGenerator.generate() },
            writeJournal: { try journalStore.write($0) },
            requestCode: requestCode,
            replace: { old, code, material, version in
                try enrollmentClient.replace(
                    oldToken: old.deviceToken,
                    code: code,
                    material: material,
                    companionVersion: version
                )
            },
            recover: { try enrollmentClient.recover(token: $0) },
            persistEnrollment: { try $0.persist(to: paths.enrollment) },
            resetCollector: {
                try AgentController.resetForReEnrollment(paths: paths.agent, surfaces: $0)
            },
            registerAgent: {
                _ = try managedAgent.perform(.register)
            },
            verifyEnrollmentAndOff: { expected in
                guard try EnrollmentConfiguration.loadExisting(from: paths.enrollment) == expected,
                      try AgentController.persistedCollectorState(
                        paths: paths.agent,
                        surfaces: expected.enabledSurfaces
                      ) == .disabled,
                      try outbox.queuedCount() == 0 else {
                    return false
                }
                return true
            },
            delayMilliseconds: delayMilliseconds,
            removeJournal: { try journalStore.remove() }
        )
    }
}

public struct ReEnrollmentCoordinator: Sendable {
    private static let recoveryDelaysMilliseconds = [100, 250, 500, 1_000]

    private let operations: ReEnrollmentOperations

    public init(operations: ReEnrollmentOperations) {
        self.operations = operations
    }

    public func run() throws -> ReEnrollmentOutcome {
        let lock = try operations.acquireLock()
        try operations.interruptionPoint(.lock)
        defer { _ = lock }

        if let journal = try operations.loadJournal() {
            return try resume(journal)
        }
        return try start()
    }

    private func start() throws -> ReEnrollmentOutcome {
        let oldConfiguration = try operations.readEnrollment()
        try operations.interruptionPoint(.readEnrollment)

        let isOff = try operations.proveCollectionOff()
        try operations.interruptionPoint(.proveCollectionOff)
        guard isOff else { return .collectionMustBeOff }

        try operations.unregisterAgent()
        try operations.interruptionPoint(.unregisterAgent)

        let queueCount = try operations.countQueue()
        try operations.interruptionPoint(.countQueue)
        guard queueCount >= 0 else { return .recoveryRequired }

        try operations.summarize(queueCount)
        try operations.interruptionPoint(.summarize)

        let confirmed = try operations.confirmReEnrollment()
        try operations.interruptionPoint(.confirmReEnrollment)
        guard confirmed else {
            return try cancel(using: oldConfiguration)
        }

        let disposition = try operations.resolveQueue(queueCount)
        switch (queueCount, disposition) {
        case (0, _):
            break
        case (_, .deliver):
            try operations.deliverQueue(oldConfiguration)
        case (_, .discard):
            try operations.discardQueue()
        case (_, .cancel):
            try operations.interruptionPoint(.resolveQueue)
            return try cancel(using: oldConfiguration)
        }
        try operations.interruptionPoint(.resolveQueue)

        let recordedDisposition: RecordedQueueDisposition
        if queueCount == 0 {
            recordedDisposition = .empty
        } else if disposition == .deliver {
            recordedDisposition = .delivered
        } else {
            recordedDisposition = .discarded
        }

        let material = try operations.generateMaterial()
        var journal = RecoveryJournal(
            version: 1,
            operationID: material.operationID,
            replacementDeviceID: material.deviceID,
            replacementDeviceToken: material.deviceToken,
            companionVersion: operations.companionVersion,
            queueDisposition: recordedDisposition,
            phase: .replacementPrepared
        )
        try operations.writeJournal(journal)
        try operations.interruptionPoint(.createJournal)

        let code = try operations.requestCode()
        try operations.interruptionPoint(.requestCode)

        let replacementResult: ReplacementHTTPResult
        do {
            replacementResult = try operations.replace(
                oldConfiguration,
                code,
                material,
                journal.companionVersion
            )
        } catch {
            return .recoveryRequired
        }
        try operations.interruptionPoint(.replace)

        switch replacementResult {
        case .committed(let recovered):
            guard let configuration = configuration(from: recovered, journal: journal) else {
                return .recoveryRequired
            }
            journal = try advance(journal, to: .serverCommitted, boundary: .serverCommitted)
            return try complete(journal, configuration: configuration)
        case .invalidEnrollment:
            return try discardUncommitted(journal, oldConfiguration: oldConfiguration)
        case .ambiguous, .unauthorized, .conflict:
            return try recoverAmbiguous(journal, oldConfiguration: oldConfiguration)
        }
    }

    private func resume(_ journal: RecoveryJournal) throws -> ReEnrollmentOutcome {
        switch journal.phase {
        case .replacementPrepared:
            let oldConfiguration = try operations.readEnrollment()
            try operations.interruptionPoint(.readEnrollment)
            return try recoverAmbiguous(journal, oldConfiguration: oldConfiguration)
        case .serverCommitted:
            let recoveredResult: RecoveredEnrollment?
            do {
                recoveredResult = try operations.recover(journal.replacementDeviceToken)
            } catch {
                return .recoveryRequired
            }
            try operations.interruptionPoint(.recoverNew)
            guard let recovered = recoveredResult else { return .recoveryRequired }
            guard let configuration = configuration(from: recovered, journal: journal) else {
                return .recoveryRequired
            }
            return try complete(journal, configuration: configuration)
        case .configurationInstalled, .collectorReset, .agentRegistered:
            let installed = try operations.readEnrollment()
            try operations.interruptionPoint(.readEnrollment)
            guard installed.deviceToken == journal.replacementDeviceToken,
                  installed.deviceID.lowercased()
                    == journal.replacementDeviceID.uuidString.lowercased() else {
                return .recoveryRequired
            }
            return try complete(journal, configuration: installed)
        }
    }

    private func recoverAmbiguous(
        _ journal: RecoveryJournal,
        oldConfiguration: EnrollmentConfiguration
    ) throws -> ReEnrollmentOutcome {
        for delay in Self.recoveryDelaysMilliseconds {
            try operations.delayMilliseconds(delay)
            try operations.interruptionPoint(.delay)
            let recovered: RecoveredEnrollment?
            do {
                recovered = try operations.recover(journal.replacementDeviceToken)
            } catch {
                return .recoveryRequired
            }
            try operations.interruptionPoint(.recoverNew)
            if let recovered {
                guard let configuration = configuration(from: recovered, journal: journal) else {
                    return .recoveryRequired
                }
                let committed = try advance(
                    journal,
                    to: .serverCommitted,
                    boundary: .serverCommitted
                )
                return try complete(committed, configuration: configuration)
            }
        }
        let oldIsActive: Bool
        do {
            oldIsActive = try operations.recover(oldConfiguration.deviceToken) != nil
        } catch {
            return .recoveryRequired
        }
        try operations.interruptionPoint(.recoverOld)
        guard oldIsActive else { return .recoveryRequired }
        return try discardUncommitted(journal, oldConfiguration: oldConfiguration)
    }

    private func discardUncommitted(
        _ journal: RecoveryJournal,
        oldConfiguration: EnrollmentConfiguration
    ) throws -> ReEnrollmentOutcome {
        guard journal.phase == .replacementPrepared else { return .recoveryRequired }
        try operations.registerAgent()
        try operations.interruptionPoint(.registerAgent)
        guard try operations.verifyEnrollmentAndOff(oldConfiguration) else {
            return .recoveryRequired
        }
        try operations.removeJournal()
        try operations.interruptionPoint(.deleteJournal)
        return .invalidEnrollment
    }

    private func cancel(using oldConfiguration: EnrollmentConfiguration) throws -> ReEnrollmentOutcome {
        try operations.registerAgent()
        try operations.interruptionPoint(.registerAgent)
        guard try operations.verifyEnrollmentAndOff(oldConfiguration) else {
            return .recoveryRequired
        }
        return .cancelled
    }

    private func complete(
        _ startingJournal: RecoveryJournal,
        configuration: EnrollmentConfiguration
    ) throws -> ReEnrollmentOutcome {
        var journal = startingJournal
        if journal.phase == .serverCommitted {
            try operations.persistEnrollment(configuration)
            try operations.interruptionPoint(.persistNewConfiguration)
            journal = try advance(
                journal,
                to: .configurationInstalled,
                boundary: .configurationInstalled
            )
        }
        if journal.phase == .configurationInstalled {
            try operations.resetCollector(configuration.enabledSurfaces)
            try operations.interruptionPoint(.resetCollector)
            journal = try advance(journal, to: .collectorReset, boundary: .collectorReset)
        }
        if journal.phase == .collectorReset {
            try operations.registerAgent()
            try operations.interruptionPoint(.registerAgent)
            journal = try advance(journal, to: .agentRegistered, boundary: .agentRegistered)
        }
        guard journal.phase == .agentRegistered,
              try operations.verifyEnrollmentAndOff(configuration) else {
            return .recoveryRequired
        }
        try operations.interruptionPoint(.verifyNewConfigurationAndOff)
        try operations.removeJournal()
        try operations.interruptionPoint(.deleteJournal)
        return .completed
    }

    private func advance(
        _ journal: RecoveryJournal,
        to phase: ReEnrollmentPhase,
        boundary: ReEnrollmentActionBoundary
    ) throws -> RecoveryJournal {
        var advanced = journal
        advanced.phase = phase
        try operations.writeJournal(advanced)
        try operations.interruptionPoint(boundary)
        return advanced
    }

    private func configuration(
        from recovered: RecoveredEnrollment,
        journal: RecoveryJournal
    ) -> EnrollmentConfiguration? {
        guard recovered.deviceID == journal.replacementDeviceID.uuidString.lowercased() else {
            return nil
        }
        return try? EnrollmentConfiguration(
            deviceID: recovered.deviceID,
            deviceToken: journal.replacementDeviceToken,
            dedupeSecret: recovered.dedupeSecret,
            serverURL: recovered.serverURL,
            cutoverAtMS: recovered.cutoverAtMS,
            enabledSurfaces: recovered.enabledSurfaces
        )
    }
}
