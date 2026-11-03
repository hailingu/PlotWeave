import CommonCrypto
import CryptoKit
import Foundation
import Security

/// Compatible provider-bound AES-GCM envelope; machine/key material never enters diagnostics.
enum NativeSeal {
    /// Existing binary-wide derivation constant is a compatibility parameter, not a secret.
    private static let pepper = "plotweave/key-seal/v1"
    /// New envelopes retain the Rust pw2 work factor; accepted stored rounds are bounded separately.
    private static let rounds: UInt32 = 600_000

    /// Provider IDs are delimiter-safe ASCII binding material shared with the preferences boundary.
    static func validateProvider(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw failure("非法 provider id")
        }
    }

    /// Only new pw2 envelopes are written; random salt and nonce prevent repeated-key ciphertext reuse.
    static func seal(provider: String, plaintext: String, material: String) throws -> String {
        try validateProvider(provider)
        var salt = Data(count: 16)
        let status = salt.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, bytes.count, base)
        }
        guard status == errSecSuccess else { throw failure("生成加密随机数失败") }
        do {
            let key = try hardenedKey(material: material, salt: salt, rounds: rounds)
            let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: key, authenticating: Data(provider.utf8))
            guard let combined = sealed.combined else { throw failure("密钥封装失败") }
            return "pw2:\(rounds):\(provider):\(hex(salt)):\(hex(combined))"
        } catch let error as HostFailure { throw error }
        catch { throw failure("密钥加密失败") }
    }

    /// Decrypts both compatible envelope generations without producing partial plaintext on failure.
    static func open(provider: String, envelope: String, material: String) throws -> String {
        let fields = envelope.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let key: SymmetricKey
        let payload: Data
        let aad: Data
        if fields.first == "pw2" {
            guard fields.count == 5, let rounds = UInt32(fields[1]), rounds > 0, rounds <= 5_000_000,
                  fields[2] == provider, fields[3].utf8.count == 32 else { throw failure("密文格式损坏或与 provider 不匹配") }
            try validateProvider(provider)
            key = try hardenedKey(material: material, salt: decodeHex(fields[3]), rounds: rounds)
            payload = try decodeHex(fields[4])
            aad = Data(provider.utf8)
        } else if fields.first == "pw1" {
            guard fields.count == 3, fields[1].utf8.count == 32 else { throw failure("旧密文格式损坏") }
            key = SymmetricKey(data: SHA256.hash(data: Data((pepper + material + fields[1]).utf8)))
            payload = try decodeHex(fields[2])
            aad = Data()
        } else { throw failure("密文格式未知") }
        guard payload.count >= 28 else { throw failure("密文长度非法") }
        do {
            let bytes = try AES.GCM.open(AES.GCM.SealedBox(combined: payload), using: key, authenticating: aad)
            guard let value = String(data: bytes, encoding: .utf8) else { throw failure("密文内容不是有效 UTF-8") }
            return value
        } catch let error as HostFailure { throw error }
        catch { throw failure("密文无法解密，请在设置页重新填写 API key") }
    }

    /// PBKDF2 consumes raw salt bytes while pw1 deliberately consumed the frozen salt-hex text.
    private static func hardenedKey(material: String, salt: Data, rounds: UInt32) throws -> SymmetricKey {
        var password = Array((pepper + material).utf8)
        var derived = [UInt8](repeating: 0, count: 32)
        defer { _ = password.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }; _ = derived.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        let status = password.withUnsafeBytes { passwordBytes in
            salt.withUnsafeBytes { saltBytes in
                derived.withUnsafeMutableBytes { output -> Int32 in
                    guard let p = passwordBytes.baseAddress, let s = saltBytes.baseAddress, let o = output.baseAddress else { return Int32(kCCParamError) }
                    return CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.assumingMemoryBound(to: Int8.self), passwordBytes.count,
                        s.assumingMemoryBound(to: UInt8.self), saltBytes.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds,
                        o.assumingMemoryBound(to: UInt8.self), output.count)
                }
            }
        }
        guard status == kCCSuccess else { throw failure("密钥派生失败") }
        return SymmetricKey(data: derived)
    }

    /// Versioned envelope hex is strict ASCII with complete byte pairs.
    private static func decodeHex(_ text: String) throws -> Data {
        let bytes = Array(text.utf8)
        guard bytes.count.isMultiple(of: 2) else { throw failure("密文不是合法 hex") }
        var output = Data()
        output.reserveCapacity(bytes.count / 2)
        for offset in stride(from: 0, to: bytes.count, by: 2) {
            guard let high = nibble(bytes[offset]), let low = nibble(bytes[offset + 1]) else { throw failure("密文不是合法 hex") }
            output.append(high * 16 + low)
        }
        return output
    }

    /// Converts only envelope-supported hex characters, without locale-dependent parsing.
    private static func nibble(_ byte: UInt8) -> UInt8? {
        if (48...57).contains(byte) { return byte - 48 }
        if (65...70).contains(byte) { return byte - 55 }
        if (97...102).contains(byte) { return byte - 87 }
        return nil
    }

    /// Lowercase hex preserves the existing JSON ciphertext wire representation.
    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// Preserves historical ioreg extraction, including its delimiter prefix, for existing ciphertext.
    static func extractMachineMaterial(_ text: String, successful: Bool) throws -> String {
        guard successful, let token = text.range(of: "IOPlatformUUID") else { throw unavailable() }
        let tail = text[token.lowerBound...]
        guard let first = tail.firstIndex(of: "\""), let last = tail.lastIndex(of: "\""),
              tail.index(after: first) < last else { throw unavailable() }
        return String(tail[tail.index(after: first)..<last])
    }

    /// Production discovery is fixed-argument and never falls back to username or logs machine output.
    static func probeMachineMaterial() throws -> String {
        let process = Process()
        let stdout = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
        process.arguments = ["-rd1", "-c", "IOPlatformExpertDevice"]
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw unavailable() }
        let bytes = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return try extractMachineMaterial(String(decoding: bytes, as: UTF8.self), successful: process.terminationReason == .exit && process.terminationStatus == 0)
    }

    /// Secret-independent diagnostics give the UI an actionable re-entry path.
    private static func failure(_ message: String) -> HostFailure { HostFailure(code: "PW_KEY_ERROR", message: message) }
    /// Machine-discovery failure is recoverable on the next call and never cached.
    private static func unavailable() -> HostFailure { HostFailure(code: "PW_MACHINE_UNAVAILABLE", message: "本机标识不可用，无法处理 API key") }
}
