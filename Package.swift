// swift-tools-version: 5.8
import PackageDescription

let package = Package(
    name: "ocr",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "OCREditor", targets: ["OCREditor"]),
        .library(name: "ocr_core", targets: ["ocr_core"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "ocr_core",
            path: "core",
            exclude: ["CMakeLists.txt", "tests/test_bridge.cpp"],
            sources: ["src"],
            publicHeadersPath: "include",
            cxxSettings: [
                .headerSearchPath("src"),
                .define("OCR_ENABLE_INPAINT", to: "1")
            ]
        ),
        .target(
            name: "OCREngineBridge",
            dependencies: ["ocr_core"],
            path: "platforms/macos/OCREditor/Bridge",
            publicHeadersPath: ".",
            cxxSettings: [
                .headerSearchPath("../../../../core/include"),
                .headerSearchPath("../../../../core/src")
            ]
        ),
        .executableTarget(
            name: "OCREditor",
            dependencies: ["OCREngineBridge"],
            path: "platforms/macos/OCREditor",
            exclude: ["Bridge"],
            sources: [
                "OCREditorApp.swift",
                "Views/ContentView.swift",
                "ViewModels/OCRViewModel.swift",
                "Models/OCRModels.swift"
            ],
            swiftSettings: [
                .unsafeFlags(["-import-objc-header", "platforms/macos/OCREditor/Bridge/OCREngineBridge.h"])
            ]
        )
    ],
    cxxLanguageStandard: .cxx17
)
