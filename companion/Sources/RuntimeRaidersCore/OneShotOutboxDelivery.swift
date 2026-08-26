import Foundation

public enum OneShotOutboxDeliveryError: Error, Equatable {
    case deliveryFailed
}

public struct OneShotOutboxDelivery {
    private let outbox: Outbox
    private let configuration: UploadConfiguration
    private let transport: Uploader.Transport

    public init(
        outbox: Outbox,
        configuration: UploadConfiguration,
        transport: @escaping Uploader.Transport
    ) throws {
        guard !configuration.deviceToken.isEmpty,
              configuration.deviceToken.utf8.count <= 4_096 else {
            throw UploaderError.invalidToken
        }
        guard configuration.allowsTestOrigin || Uploader.isProductionOrigin(configuration.origin) else {
            throw UploaderError.invalidOrigin
        }
        self.outbox = outbox
        self.configuration = configuration
        self.transport = transport
    }

    public func drain() throws -> Int {
        var delivered = 0
        while true {
            let batch = try outbox.validatedDeliveryBatch(limit: 100)
            let records = batch.records
            guard !records.isEmpty else { return delivered }
            let request = try UploadBatchWire.request(
                records: records,
                configuration: configuration
            )
            let response: UploadHTTPResponse
            do {
                response = try transport(request)
            } catch {
                throw OneShotOutboxDeliveryError.deliveryFailed
            }
            guard UploadBatchWire.accepts(response, expectedCount: records.count) else {
                throw OneShotOutboxDeliveryError.deliveryFailed
            }
            try outbox.acknowledge(batch)
            let (next, overflow) = delivered.addingReportingOverflow(records.count)
            guard !overflow else { throw OneShotOutboxDeliveryError.deliveryFailed }
            delivered = next
        }
    }
}
