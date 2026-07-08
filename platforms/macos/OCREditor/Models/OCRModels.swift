//
//  OCRModels.swift
//  OCREditor
//
//  Swift 資料模型 — 用於 SwiftUI 介面層的 OCR 辨識結果表示
//

import Foundation
#if os(macOS)

#endif

// MARK: - BoundingBox

/// 文字區域的四角座標
struct BoundingBox: Equatable, Codable {
    var topLeft: CGPoint
    var topRight: CGPoint
    var bottomRight: CGPoint
    var bottomLeft: CGPoint

    mutating func update(with newRect: CGRect) {
        self.topLeft = CGPoint(x: newRect.minX, y: newRect.minY)
        self.topRight = CGPoint(x: newRect.maxX, y: newRect.minY)
        self.bottomLeft = CGPoint(x: newRect.minX, y: newRect.maxY)
        self.bottomRight = CGPoint(x: newRect.maxX, y: newRect.maxY)
    }

    /// 軸對齊包圍矩形
    var rect: CGRect {
        let minX = min(topLeft.x, bottomLeft.x, topRight.x, bottomRight.x)
        let minY = min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y)
        let maxX = max(topLeft.x, bottomLeft.x, topRight.x, bottomRight.x)
        let maxY = max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y)
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// 中心點
    var center: CGPoint {
        CGPoint(x: rect.midX, y: rect.midY)
    }

    /// 零值
    static let zero = BoundingBox(
        topLeft: .zero, topRight: .zero,
        bottomRight: .zero, bottomLeft: .zero
    )
}

// MARK: - FontEstimate

/// 推估字體資訊
struct FontEstimate: Equatable {
    var sizePx: CGFloat       ///< 推估字級大小（像素）
    var color: PlatformColor  ///< 推估文字顏色
    var isBold: Bool          ///< 是否為粗體
    var fontName: String      ///< 字型名稱

    init(sizePx: CGFloat, color: PlatformColor, isBold: Bool, fontName: String = "PingFang TC") {
        self.sizePx = sizePx
        self.color = color
        self.isBold = isBold
        self.fontName = fontName
    }

    /// 轉換為 PlatformFont (本地端預設字型 Fallback 替換)
    var nsFont: PlatformFont {
        let size = sizePx > 0 ? sizePx : 14.0
        
        var finalFontName = "NotoSansTC-Regular" // 預設使用我們打包的 Noto Sans
        
        if fontName != "System" && !fontName.isEmpty {
            let lower = fontName.lowercased()
            // 判斷是否為襯線字體 (Serif / 明體 / 宋體)
            if lower.contains("serif") || lower.contains("song") || lower.contains("ming") || lower.contains("times") {
                finalFontName = isBold ? "NotoSerifTC-Bold" : "NotoSerifTC-Regular"
                // 註：目前我們只下載了 Regular，所以統一對應到 Regular。若有 Bold 再換。
                finalFontName = "NotoSerifTC-Regular"
            } else {
                // 無襯線字體 (Sans-serif / 黑體 / Arial)
                finalFontName = isBold ? "NotoSansTC-Bold" : "NotoSansTC-Regular"
                finalFontName = "NotoSansTC-Regular"
            }
            
            // 先嘗試載入系統內建的原字體 (如 PingFang TC 等) 以確保最佳原生體驗
            var nativeFontName = fontName
            if isBold {
                if fontName == "PingFang TC" { nativeFontName = "PingFangTC-Semibold" }
                else if fontName == "PingFang SC" { nativeFontName = "PingFangSC-Semibold" }
                else if fontName == "Heiti TC" { nativeFontName = "STHeitiTC-Medium" }
                else if fontName == "Songti TC" { nativeFontName = "STSongti-TC-Bold" }
                else if fontName == "Arial" { nativeFontName = "Arial-BoldMT" }
                else if fontName == "Helvetica" { nativeFontName = "Helvetica-Bold" }
                else if fontName == "Times New Roman" { nativeFontName = "TimesNewRomanPS-BoldMT" }
            } else {
                if fontName == "PingFang TC" { nativeFontName = "PingFangTC-Regular" }
                else if fontName == "PingFang SC" { nativeFontName = "PingFangSC-Regular" }
                else if fontName == "Heiti TC" { nativeFontName = "STHeitiTC-Light" }
                else if fontName == "Songti TC" { nativeFontName = "STSongti-TC-Regular" }
            }
            
            // 1. 嘗試系統原生字體
            if let customFont = PlatformFont(name: nativeFontName, size: size) {
                return customFont
            }
        }
        
        // 2. 找不到時，嘗試載入我們打包的字體
        // 注意：UIAppFonts 必須註冊成功，且名稱對應 (NotoSansCJKtc-Regular 等)
        // 為了安全，若打包字型名稱讀取失敗，最後 Fallback 回系統預設字體
        if let bundledFont = PlatformFont(name: finalFontName, size: size) {
            return bundledFont
        }
        
        // NotoCJK 的實際 PostScript 名稱可能是 NotoSansCJKtc-Regular
        if let bundledFont = PlatformFont(name: "NotoSansCJKtc-Regular", size: size) {
            return bundledFont
        }
        if let bundledFont = PlatformFont(name: "NotoSerifCJKtc-Regular", size: size) {
            return bundledFont
        }
        
        // 3. Fallback to system font
        if isBold {
            return PlatformFont.boldSystemFont(ofSize: size)
        } else {
            return PlatformFont.systemFont(ofSize: size)
        }
    }

    /// 預設值
    static let `default` = FontEstimate(
        sizePx: 14.0,
        color: .black,
        isBold: false,
        fontName: "PingFang TC"
    )
}

// MARK: - TextWord

/// 辨識出的單一詞彙（可選取、可編輯）
struct TextWord: Identifiable, Equatable {
    let id: UUID
    var text: String                ///< 詞彙文字（可編輯）
    let confidence: Double          ///< 信心度 (0.0–1.0)
    let boundingBox: BoundingBox    ///< 位置
    var fontEstimate: FontEstimate  ///< 推估字體
    var isSelected: Bool            ///< 是否被選取

    init(
        id: UUID = UUID(),
        text: String,
        confidence: Double,
        boundingBox: BoundingBox,
        fontEstimate: FontEstimate = .default,
        isSelected: Bool = false
    ) {
        self.id = id
        self.text = text
        self.confidence = confidence
        self.boundingBox = boundingBox
        self.fontEstimate = fontEstimate
        self.isSelected = isSelected
    }
}

// MARK: - TextLine

/// 辨識出的文字行
struct TextLine: Identifiable, Equatable {
    let id: UUID
    let text: String                ///< 整行文字
    let confidence: Double          ///< 行信心度
    let boundingBox: BoundingBox    ///< 行位置
    var words: [TextWord]           ///< 詞彙陣列

    init(
        id: UUID = UUID(),
        text: String,
        confidence: Double,
        boundingBox: BoundingBox,
        words: [TextWord] = []
    ) {
        self.id = id
        self.text = text
        self.confidence = confidence
        self.boundingBox = boundingBox
        self.words = words
    }
}

// MARK: - TextBlock

/// 辨識出的文字區塊
struct TextBlock: Identifiable, Equatable {
    /// 區塊類型
    enum BlockType: String, CaseIterable, Codable {
        case paragraph = "paragraph"   ///< 段落
        case table     = "table"       ///< 表格
        case header    = "header"      ///< 標題
        case caption   = "caption"     ///< 圖說
        case unknown   = "unknown"     ///< 未知

        /// 顯示名稱（中文）
        var displayName: String {
            switch self {
            case .paragraph: return "段落"
            case .table:     return "表格"
            case .header:    return "標題"
            case .caption:   return "圖說"
            case .unknown:   return "未知"
            }
        }

        /// 從字串轉換
        static func from(_ string: String) -> BlockType {
            return BlockType(rawValue: string.lowercased()) ?? .unknown
        }
    }

    let id: UUID
    let type: BlockType             ///< 區塊類型
    let confidence: Double          ///< 區塊信心度
    let boundingBox: BoundingBox    ///< 區塊位置
    var lines: [TextLine]           ///< 行陣列

    init(
        id: UUID = UUID(),
        type: BlockType = .unknown,
        confidence: Double = 0.0,
        boundingBox: BoundingBox = .zero,
        lines: [TextLine] = []
    ) {
        self.id = id
        self.type = type
        self.confidence = confidence
        self.boundingBox = boundingBox
        self.lines = lines
    }
}

// MARK: - OCRScanResult

/// 完整的 OCR 掃描結果
struct OCRScanResult: Identifiable, Equatable {
    let id: UUID
    let originalImage: PlatformImage      ///< 原始影像
    let dimensions: CGSize          ///< 影像尺寸
    var textBlocks: [TextBlock]     ///< 文字區塊陣列
    var rawJson: String?            ///< 原始 JSON (用於 C++ 匯出)

    /// 全文（所有行串接）
    var fullText: String {
        textBlocks
            .flatMap { $0.lines }
            .map { $0.text }
            .joined(separator: "\n")
    }

    /// 總詞彙數
    var wordCount: Int {
        textBlocks
            .flatMap { $0.lines }
            .flatMap { $0.words }
            .count
    }

    /// 平均信心度
    var averageConfidence: Double {
        let allWords = textBlocks.flatMap { $0.lines }.flatMap { $0.words }
        guard !allWords.isEmpty else { return 0.0 }
        let total = allWords.reduce(0.0) { $0 + $1.confidence }
        return total / Double(allWords.count)
    }

    init(
        id: UUID = UUID(),
        originalImage: PlatformImage,
        dimensions: CGSize,
        textBlocks: [TextBlock] = [],
        rawJson: String? = nil
    ) {
        self.id = id
        self.originalImage = originalImage
        self.dimensions = dimensions
        self.textBlocks = textBlocks
        self.rawJson = rawJson
    }

    // Equatable — 只比較 id（影像不做深層比較）
    static func == (lhs: OCRScanResult, rhs: OCRScanResult) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Bridge 轉換擴充

extension BoundingBox {
    /// 從 Objective-C OCRBoundingBox 轉換
    static func from(bridge bbox: OCRBoundingBox) -> BoundingBox {
        BoundingBox(
            topLeft:     bbox.topLeft,
            topRight:    bbox.topRight,
            bottomRight: bbox.bottomRight,
            bottomLeft:  bbox.bottomLeft
        )
    }
}

extension OCRScanResult {
    /// 從 Objective-C OCRResult 建立 Swift 模型
    /// - Parameters:
    ///   - bridgeResult: 橋接層辨識結果
    ///   - originalImage: 原始輸入影像
    static func from(bridgeResult: OCRResult, originalImage: PlatformImage) -> OCRScanResult {
        let blocks: [TextBlock] = bridgeResult.textBlocks.map { bridgeBlock in
            let lines: [TextLine] = bridgeBlock.lines.map { bridgeLine in
                let words: [TextWord] = bridgeLine.words.map { bridgeWord in
                    // 建立字體推估
                    let fontEstimate = FontEstimate(
                        sizePx: bridgeWord.estimatedFontSize > 0 ? bridgeWord.estimatedFontSize : 14,
                        color: bridgeWord.estimatedColor ?? .black,
                        isBold: bridgeWord.isBold
                    )

                    return TextWord(
                        text: bridgeWord.text,
                        confidence: bridgeWord.confidence,
                        boundingBox: .from(bridge: bridgeWord.boundingBox),
                        fontEstimate: fontEstimate
                    )
                }

                return TextLine(
                    text: bridgeLine.text,
                    confidence: bridgeLine.confidence,
                    boundingBox: .from(bridge: bridgeLine.boundingBox),
                    words: words
                )
            }

            return TextBlock(
                type: .from(bridgeBlock.type),
                confidence: bridgeBlock.confidence,
                boundingBox: .from(bridge: bridgeBlock.boundingBox),
                lines: lines
            )
        }

        return OCRScanResult(
            originalImage: originalImage,
            dimensions: bridgeResult.imageDimensions,
            textBlocks: blocks,
            rawJson: bridgeResult.rawJson
        )
    }
}

// MARK: - Canvas Layer Model

enum CanvasLayerType: String, Codable {
    case text = "text"
    case image = "image"
    case vector = "vector"
}

struct CanvasLayer: Identifiable, Equatable {
    let id: UUID
    let layerId: String          ///< C++ side layer id (e.g. "slide1_title" or "block_1")
    var type: CanvasLayerType
    var name: String
    var text: String              ///< For text layers
    var boundingBox: BoundingBox
    var fontEstimate: FontEstimate ///< For text layers
    var isSelected: Bool
    var localImagePath: String?   ///< For image layers
    var image: PlatformImage?           ///< Loaded image data

    init(
        id: UUID = UUID(),
        layerId: String,
        type: CanvasLayerType,
        name: String,
        text: String = "",
        boundingBox: BoundingBox,
        fontEstimate: FontEstimate = .default,
        isSelected: Bool = false,
        localImagePath: String? = nil,
        image: PlatformImage? = nil
    ) {
        self.id = id
        self.layerId = layerId
        self.type = type
        self.name = name
        self.text = text
        self.boundingBox = boundingBox
        self.fontEstimate = fontEstimate
        self.isSelected = isSelected
        self.localImagePath = localImagePath
        self.image = image
    }
}

struct CanvasDocument: Identifiable, Equatable {
    let id: UUID
    var name: String
    var dimensions: CGSize
    var layers: [CanvasLayer]

    init(
        id: UUID = UUID(),
        name: String,
        dimensions: CGSize = CGSize(width: 1920, height: 1080),
        layers: [CanvasLayer] = []
    ) {
        self.id = id
        self.name = name
        self.dimensions = dimensions
        self.layers = layers
    }
}
