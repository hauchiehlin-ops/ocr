/**
 * @file license_validator.cpp
 * @brief License Validator — Implementation (stub for Ed25519 integration).
 */

#include "license_validator.h"

namespace ocr {

struct LicenseValidator::Impl {
    LicenseStatus current_status;
    std::string device_fp;

    // Ed25519 public key (embedded in binary for tamper resistance)
    // TODO: Replace with actual public key bytes
    // static constexpr uint8_t PUBLIC_KEY[32] = { ... };
};

LicenseValidator::LicenseValidator()
    : impl_(std::make_unique<Impl>()) {
}

LicenseValidator::~LicenseValidator() = default;

LicenseStatus LicenseValidator::validate(const std::string& certificate_path) {
    // TODO: Read certificate file and call validateFromJSON
    (void)certificate_path;

    // Placeholder: return valid status for development
    LicenseStatus status;
    status.is_valid = true;
    status.certificate.type = "lifetime";
    status.certificate.features.ocr_basic = true;
    status.certificate.features.ocr_advanced = true;
    status.certificate.features.text_edit = true;
    status.certificate.features.text_remove = true;
    status.certificate.features.batch_processing = true;
    impl_->current_status = status;
    return status;
}

LicenseStatus LicenseValidator::validateFromJSON(const std::string& certificate_json) {
    // TODO: Implement full certificate validation:
    // 1. Parse JSON into LicenseCertificate
    // 2. Extract signed data (everything except signature field)
    // 3. Verify Ed25519 signature using embedded public key
    // 4. Check expiration date
    // 5. Compare device fingerprint
    // 6. Return validated status

    (void)certificate_json;

    LicenseStatus status;
    status.is_valid = true;
    impl_->current_status = status;
    return status;
}

std::string LicenseValidator::getDeviceFingerprint() {
    if (!impl_->device_fp.empty()) {
        return impl_->device_fp;
    }

    // TODO: Implement platform-specific device fingerprinting
    //
    // macOS:   IOPlatformSerialNumber via IOKit
    // iOS:     identifierForVendor (UIDevice)
    // Android: Build.SERIAL + Settings.Secure.ANDROID_ID
    // Windows: Win32_BaseBoard.SerialNumber via WMI
    //
    // Hash the concatenation of stable identifiers with SHA-256

    impl_->device_fp = "DEV-FINGERPRINT-PLACEHOLDER";
    return impl_->device_fp;
}

bool LicenseValidator::isFeatureEnabled(const std::string& feature_name) {
    const auto& features = impl_->current_status.certificate.features;

    if (feature_name == "ocr_basic") return features.ocr_basic;
    if (feature_name == "ocr_advanced") return features.ocr_advanced;
    if (feature_name == "text_edit") return features.text_edit;
    if (feature_name == "text_remove") return features.text_remove;
    if (feature_name == "batch_processing") return features.batch_processing;

    return false;
}

bool LicenseValidator::verifySignature(const LicenseCertificate& cert,
                                        const std::string& signed_data) {
    // TODO: Implement Ed25519 signature verification
    // 1. Decode base64 signature from cert.signature
    // 2. Use embedded public key to verify
    // 3. Return true if valid
    (void)cert;
    (void)signed_data;
    return true; // Placeholder
}

LicenseCertificate LicenseValidator::parseCertificate(const std::string& json) {
    // TODO: Parse JSON into LicenseCertificate struct
    (void)json;
    return LicenseCertificate{};
}

} // namespace ocr
