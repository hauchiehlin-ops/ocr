/**
 * @file device_fingerprint.cpp
 * @brief Device Fingerprint — Platform-specific hardware identification.
 *
 * Stub file. Implementation details in license_validator.cpp.
 */

// Platform-specific fingerprinting is implemented in
// license_validator.cpp → getDeviceFingerprint()
//
// Each platform uses different APIs:
//   macOS:   IOKit → IOPlatformSerialNumber
//   iOS:     UIDevice.identifierForVendor
//   Android: Build.SERIAL + Settings.Secure.ANDROID_ID
//   Windows: WMI → Win32_BaseBoard.SerialNumber
