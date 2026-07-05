/**
 * @file license_validator.h
 * @brief License Validator — Ed25519-based offline license verification.
 *
 * Implements the cryptographic license validation system:
 * - Ed25519 signature verification (public key embedded in binary)
 * - Device fingerprint generation (hardware UUID)
 * - License certificate parsing and validation
 * - Offline-first with optional online refresh
 */

#ifndef OCR_LICENSE_VALIDATOR_H
#define OCR_LICENSE_VALIDATOR_H

#include <string>
#include <memory>
#include <vector>
#include <ctime>

namespace ocr {

/**
 * @brief License certificate data.
 */
struct LicenseCertificate {
    std::string license_id;
    std::string product;
    std::string type;              // "lifetime", "trial", "subscription"
    std::vector<std::string> platforms;  // ["ios", "android", "macos", "windows"]
    int max_devices = 5;
    std::string device_fingerprint;
    std::time_t issued_at = 0;
    std::time_t expires_at = 0;    // 0 = never (lifetime)

    struct Features {
        bool ocr_basic = false;
        bool ocr_advanced = false;
        bool text_edit = false;
        bool text_remove = false;
        bool batch_processing = false;
    } features;

    std::string signature;         // Ed25519 signature (base64)
};

/**
 * @brief License validation result.
 */
struct LicenseStatus {
    bool is_valid = false;
    bool is_expired = false;
    bool is_device_bound = false;
    std::string error_message;
    LicenseCertificate certificate;
};

/**
 * @brief License Validator — Offline-first Ed25519 verification.
 */
class LicenseValidator {
public:
    LicenseValidator();
    ~LicenseValidator();

    /**
     * @brief Validate a license certificate file.
     *
     * @param certificate_path  Path to the license certificate JSON file.
     * @return LicenseStatus with validation result.
     */
    LicenseStatus validate(const std::string& certificate_path);

    /**
     * @brief Validate a license certificate from JSON string.
     *
     * @param certificate_json  License certificate JSON content.
     * @return LicenseStatus with validation result.
     */
    LicenseStatus validateFromJSON(const std::string& certificate_json);

    /**
     * @brief Get the device fingerprint for this machine.
     *
     * Uses hardware UUID (motherboard serial + OS UUID) to generate
     * a stable, unique identifier for license binding.
     *
     * @return Device fingerprint string.
     */
    std::string getDeviceFingerprint();

    /**
     * @brief Check if a specific feature is enabled.
     *
     * @param feature_name  Feature identifier (e.g., "text_remove").
     * @return true if the feature is available in the current license.
     */
    bool isFeatureEnabled(const std::string& feature_name);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    /// Verify Ed25519 signature of the certificate
    bool verifySignature(const LicenseCertificate& cert,
                        const std::string& signed_data);

    /// Parse certificate JSON into LicenseCertificate struct
    LicenseCertificate parseCertificate(const std::string& json);
};

} // namespace ocr

#endif // OCR_LICENSE_VALIDATOR_H
