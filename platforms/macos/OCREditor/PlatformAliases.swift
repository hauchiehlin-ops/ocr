//
//  PlatformAliases.swift
//  OCREditor
//
//  Created for Cross-Platform Support (macOS / iOS)
//

import SwiftUI

#if os(macOS)
import AppKit

public typealias PlatformImage = NSImage
public typealias PlatformColor = NSColor
public typealias PlatformView = NSView
public typealias PlatformViewController = NSViewController
public typealias PlatformFont = NSFont

extension PlatformColor {
    static var themeWindowBackground: PlatformColor { return .windowBackgroundColor }
    static var themeUnderPageBackground: PlatformColor { return .underPageBackgroundColor }
    static var themeControlBackground: PlatformColor { return .controlBackgroundColor }
}

extension NSImage {
    var platformCGImage: CGImage? {
        return self.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }
}



#elseif os(iOS)
import UIKit

public typealias PlatformImage = UIImage
public typealias PlatformColor = UIColor
public typealias PlatformView = UIView
public typealias PlatformViewController = UIViewController
public typealias PlatformFont = UIFont

extension PlatformColor {
    static var themeWindowBackground: PlatformColor { return .systemBackground }
    static var themeUnderPageBackground: PlatformColor { return .secondarySystemBackground }
    static var themeControlBackground: PlatformColor { return .tertiarySystemBackground }
}

extension UIImage {
    var platformCGImage: CGImage? {
        return self.cgImage
    }
}



#endif

public extension Color {
    init(platformColor: PlatformColor) {
        #if os(macOS)
        self.init(nsColor: platformColor)
        #elseif os(iOS)
        self.init(uiColor: platformColor)
        #endif
    }
}

public extension Image {
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #elseif os(iOS)
        self.init(uiImage: platformImage)
        #endif
    }
}
