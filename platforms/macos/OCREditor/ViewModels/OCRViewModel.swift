//
//  OCRViewModel.swift
//  OCREditor
//
//  主要 ViewModel — 管理 OCR 引擎、辨識流程、文字編輯與歷史記錄
//

import Foundation
import AppKit
import SwiftUI
import PDFKit

// MARK: - 狀態列舉

/// 處理狀態
enum ProcessingState: Equatable {
    case idle                   ///< 閒置
    case loading                ///< 載入影像中
    case recognizing            ///< OCR 辨識中
    case inpainting             ///< 文字移除（修復背景）中
    case replacing              ///< 文字替換中
    case complete               ///< 處理完成
    case error(String)          ///< 發生錯誤

    /// 狀態顯示文字
    var displayText: String {
        switch self {
        case .idle:            return "就緒"
        case .loading:         return "載入影像中…"
        case .recognizing:     return "辨識文字中…"
        case .inpainting:      return "移除文字中…"
        case .replacing:       return "替換文字中…"
        case .complete:        return "處理完成"
        case .error(let msg):  return "錯誤：\(msg)"
        }
    }

    /// 是否正在處理
    var isProcessing: Bool {
        switch self {
        case .loading, .recognizing, .inpainting, .replacing:
            return true
        default:
            return false
        }
    }
}

/// 編輯模式
enum EditMode: String, CaseIterable, Identifiable {
    case view   = "檢視"
    case select = "選取"
    case edit   = "編輯"
    case delete = "刪除"

    var id: String { rawValue }

    /// SF Symbol 圖示名稱
    var iconName: String {
        switch self {
        case .view:   return "eye"
        case .select: return "cursorarrow.click"
        case .edit:   return "pencil"
        case .delete: return "trash"
        }
    }
}

// MARK: - 編輯快照（用於 Undo/Redo）

/// 保存掃描結果狀態的快照
private struct EditSnapshot {
    let textBlocks: [TextBlock]
    let description: String    ///< 操作描述（用於 Undo 選單）
}

// MARK: - OCRViewModel

@MainActor
final class OCRViewModel: ObservableObject {

    // MARK: Published 屬性

    @Published var state: ProcessingState = .idle               ///< 處理狀態
    @Published var isTranslating = false                        ///< 是否正在翻譯
    @Published var scanResult: OCRScanResult? = nil             ///< 辨識結果
    @Published var selectedWordIds: Set<UUID> = []              ///< 選取的詞彙 ID
    @Published var editMode: EditMode = .view                   ///< 當前編輯模式
    @Published var errorMessage: String? = nil                  ///< 錯誤訊息
    @Published var progress: Double = 0.0                       ///< 進度 (0.0–1.0)
    @Published var canvasDocument: CanvasDocument? = nil        ///< 圖層編輯畫布
    @Published var selectedLayerId: UUID? = nil {
        didSet {
            if let id = selectedLayerId, let layer = canvasDocument?.layers.first(where: { $0.id == id }) {
                inspectorFontSize = layer.fontEstimate.sizePx
                inspectorFontColor = Color(layer.fontEstimate.color)
                inspectorIsBold = layer.fontEstimate.isBold
                inspectorText = layer.text
            }
        }
    }
    @Published var inspectorFontSize: CGFloat = 14 {
        didSet { updateSelectedLayerProperties() }
    }
    @Published var inspectorFontColor: Color = .black {
        didSet { updateSelectedLayerProperties() }
    }
    @Published var inspectorIsBold: Bool = false {
        didSet { updateSelectedLayerProperties() }
    }
    @Published var inspectorText: String = "" {
        didSet { updateSelectedLayerText() }
    }

    /// 是否可以還原
    var canUndo: Bool {
        editHistoryIndex > 0
    }

    /// 是否可以重做
    var canRedo: Bool {
        editHistoryIndex < editHistory.count - 1
    }

    // MARK: 私有屬性

    private var engine: OCREngineBridge?
    private var editHistory: [EditSnapshot] = []
    private var editHistoryIndex: Int = -1

    // MARK: - 初始化

    init() {
        setupEngine()
    }

    // MARK: - 引擎設定

    /// 從 Bundle 載入模型並初始化 OCR 引擎
    func setupEngine() {
        // 嘗試從 App Bundle 中尋找模型目錄
        let possiblePaths = [
            Bundle.main.resourcePath.map { "\($0)/models" },
            Bundle.main.resourcePath.map { "\($0)/OCRModels" },
            Bundle.main.path(forResource: "models", ofType: nil),
            Bundle.main.path(forResource: "OCRModels", ofType: nil)
        ].compactMap { $0 }

        for modelPath in possiblePaths {
            if FileManager.default.fileExists(atPath: modelPath) {
                engine = OCREngineBridge(modelDirectory: modelPath)
                if engine?.isReady == true {
                    print("[OCRViewModel] ✅ 引擎初始化成功，模型路徑: \(modelPath)")
                    return
                }
            }
        }

        // 開發環境備援：使用專案根目錄的模型
        let devModelPath = "/Users/barretlin/GitProjects/OCR/models"
        if FileManager.default.fileExists(atPath: devModelPath) {
            engine = OCREngineBridge(modelDirectory: devModelPath)
            if engine?.isReady == true {
                print("[OCRViewModel] ✅ 引擎初始化成功（開發模式），模型路徑: \(devModelPath)")
                return
            }
        }

        print("[OCRViewModel] ⚠️ 未找到模型目錄，引擎將於首次使用時提示錯誤")
    }

    // MARK: - 影像掃描

    /// 從檔案 URL 掃描影像/簡報/PDF
    /// - Parameter url: 檔案 URL
    func scanImage(from url: URL) async {
        state = .loading
        progress = 0.1

        let ext = url.pathExtension.lowercased()
        if ext == "pptx" {
            await parsePptx(url: url)
        } else if ext == "pdf" {
            await parsePdf(url: url)
        } else {
            guard let image = NSImage(contentsOf: url) else {
                state = .error("無法載入影像檔案")
                errorMessage = "無法讀取所選影像，請確認檔案格式正確。"
                return
            }
            await scanImage(image)
        }
    }

    private func parsePptx(url: URL) async {
        state = .recognizing
        progress = 0.3
        
        guard let engine = engine, engine.isReady else {
            state = .error("OCR 引擎未就緒")
            return
        }
        
        do {
            let jsonString = try engine.parsePptxFile(url.path)
            guard let jsonData = jsonString.data(using: String.Encoding.utf8) else {
                state = .error("無法解析簡報資料格式")
                return
            }
                
                let pptDoc = try JSONDecoder().decode(PptxJSONDocument.self, from: jsonData)
                if let firstSlide = pptDoc.slides.first {
                    var layers: [CanvasLayer] = []
                    for pLayer in firstSlide.layers {
                        let type: CanvasLayerType
                        switch pLayer.type {
                        case "text": type = .text
                        case "image": type = .image
                        case "vector": type = .vector
                        default: type = .vector
                        }
                        
                        let bbox = BoundingBox(
                            topLeft: CGPoint(x: pLayer.bbox.top_left[0], y: pLayer.bbox.top_left[1]),
                            topRight: CGPoint(x: pLayer.bbox.top_right[0], y: pLayer.bbox.top_right[1]),
                            bottomRight: CGPoint(x: pLayer.bbox.bottom_right[0], y: pLayer.bbox.bottom_right[1]),
                            bottomLeft: CGPoint(x: pLayer.bbox.bottom_left[0], y: pLayer.bbox.bottom_left[1])
                        )
                        
                        var fontEst = FontEstimate.default
                        if let fs = pLayer.font_size {
                            fontEst.sizePx = CGFloat(fs)
                        }
                        if let fc = pLayer.font_color, fc.count >= 3 {
                            fontEst.color = NSColor(red: CGFloat(fc[0])/255.0, green: CGFloat(fc[1])/255.0, blue: CGFloat(fc[2])/255.0, alpha: 1.0)
                        }
                        if let ib = pLayer.is_bold {
                            fontEst.isBold = ib
                        }
                        
                        let layer = CanvasLayer(
                            layerId: pLayer.id,
                            type: type,
                            name: pLayer.name,
                            text: pLayer.text ?? "",
                            boundingBox: bbox,
                            fontEstimate: fontEst,
                            localImagePath: pLayer.image_path
                        )
                        layers.append(layer)
                    }
                    
                    self.canvasDocument = CanvasDocument(
                        name: url.lastPathComponent,
                        dimensions: CGSize(width: CGFloat(firstSlide.width), height: CGFloat(firstSlide.height)),
                        layers: layers
                    )
                    state = .complete
                    progress = 1.0
                } else {
                    state = .error("簡報無投影片內容")
                }
            } catch {
                state = .error("PPTX 解析錯誤: \(error.localizedDescription)")
            }
    }

    private func parsePdf(url: URL) async {
        state = .recognizing
        progress = 0.3
        
        guard let pdfDoc = PDFDocument(url: url), pdfDoc.pageCount > 0 else {
            state = .error("無法讀取 PDF 檔案")
            return
        }
        
        guard let firstPage = pdfDoc.page(at: 0) else {
            state = .error("無法獲取 PDF 第一頁")
            return
        }
        
        let pdfBounds = firstPage.bounds(for: .mediaBox)
        let dimensions = CGSize(width: pdfBounds.width, height: pdfBounds.height)
        
        let image = NSImage(size: dimensions)
        image.lockFocus()
        if let context = NSGraphicsContext.current?.cgContext {
            context.setFillColor(NSColor.white.cgColor)
            context.fill(CGRect(origin: .zero, size: dimensions))
            firstPage.draw(with: .mediaBox, to: context)
        }
        image.unlockFocus()
        
        await performOCR(on: image)
        
        if let result = self.scanResult {
            var layers: [CanvasLayer] = []
            
            let bgLayer = CanvasLayer(
                layerId: "pdf_bg_page1",
                type: .image,
                name: "PDF 頁面背景",
                boundingBox: BoundingBox(
                    topLeft: CGPoint(x: 0, y: dimensions.height),
                    topRight: CGPoint(x: dimensions.width, y: dimensions.height),
                    bottomRight: CGPoint(x: dimensions.width, y: 0),
                    bottomLeft: CGPoint(x: 0, y: 0)
                ),
                image: image
            )
            layers.append(bgLayer)
            
            var textId = 0
            for block in result.textBlocks {
                for line in block.lines {
                    for word in line.words {
                        textId += 1
                        let layer = CanvasLayer(
                            layerId: "pdf_text_\(textId)",
                            type: .text,
                            name: "文字區塊 \(textId)",
                            text: word.text,
                            boundingBox: word.boundingBox,
                            fontEstimate: word.fontEstimate
                        )
                        layers.append(layer)
                    }
                }
            }
            
            self.canvasDocument = CanvasDocument(
                name: url.lastPathComponent,
                dimensions: dimensions,
                layers: layers
            )
            state = .complete
            progress = 1.0
        }
    }

    private func updateSelectedLayerProperties() {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            doc.layers[idx].fontEstimate.sizePx = inspectorFontSize
            doc.layers[idx].fontEstimate.color = NSColor(inspectorFontColor)
            doc.layers[idx].fontEstimate.isBold = inspectorIsBold
            self.canvasDocument = doc
        }
    }

    private func updateSelectedLayerText() {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            if doc.layers[idx].text != inspectorText {
                doc.layers[idx].text = inspectorText
                self.canvasDocument = doc
            }
        }
    }
    
    /// 執行選取圖層的原地翻譯 (端側離線)
    func translateSelectedLayer() async {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            let originalText = doc.layers[idx].text
            guard !originalText.isEmpty else { return }
            
            isTranslating = true
            defer { isTranslating = false }
            
            // 模擬本地端離線簡繁/中英翻譯對照
            let translated: String
            if originalText == "離線文件圖層編輯器" {
                translated = "Offline Document Layer Editor"
            } else if originalText == "支援圖層分離、富文字格式與元件替換之完整畫布工作流" {
                translated = "Full canvas workflow supporting layer separation, rich text formatting, and component replacement"
            } else {
                translated = "[Translated] " + originalText
            }
            
            doc.layers[idx].text = translated
            self.inspectorText = translated
            self.canvasDocument = doc
        }
    }
    
    func replaceSelectedLayerImage(with newImage: NSImage) {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            doc.layers[idx].image = newImage
            doc.layers[idx].type = .image
            self.canvasDocument = doc
        }
    }

    func deleteSelectedLayer() {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        doc.layers.removeAll { $0.id == id }
        selectedLayerId = nil
        self.canvasDocument = doc
    }

    // Codable Decoders for PPTX JSON
    private struct PptxJSONLayer: Codable {
        let id: String
        let type: String
        let name: String
        let text: String?
        let bbox: PptxJSONBBox
        let font_size: Float?
        let font_color: [Int]?
        let is_bold: Bool?
        let image_path: String?
    }

    private struct PptxJSONBBox: Codable {
        let top_left: [CGFloat]
        let top_right: [CGFloat]
        let bottom_right: [CGFloat]
        let bottom_left: [CGFloat]
    }

    private struct PptxJSONSlide: Codable {
        let slide_number: Int
        let width: Int
        let height: Int
        let layers: [PptxJSONLayer]
    }

    private struct PptxJSONDocument: Codable {
        let slides: [PptxJSONSlide]
    }

    /// 掃描指定影像
    /// - Parameter image: 輸入的 NSImage
    func scanImage(_ image: NSImage) async {
        state = .recognizing
        progress = 0.3

        await performOCR(on: image)
    }

    // MARK: - 文字操作

    /// 刪除選取的文字（修復背景）
    func deleteSelectedText() async {
        guard let result = scanResult, !selectedWordIds.isEmpty else { return }
        guard let engine = engine, engine.isReady else {
            state = .error("OCR 引擎未就緒")
            return
        }

        // 保存編輯前快照
        saveSnapshot(description: "刪除文字")

        state = .inpainting
        progress = 0.5

        // 收集選取詞彙的邊界框
        let selectedBBoxes: [OCRBoundingBox] = result.textBlocks
            .flatMap { $0.lines }
            .flatMap { $0.words }
            .filter { selectedWordIds.contains($0.id) }
            .map { word -> OCRBoundingBox in
                let bbox = word.boundingBox
                return OCRBoundingBox(
                    topLeft: bbox.topLeft,
                    topRight: bbox.topRight,
                    bottomRight: bbox.bottomRight,
                    bottomLeft: bbox.bottomLeft
                )
            }

        // 在背景執行緒執行
        let image = result.originalImage
        let processedImage: NSImage? = await Task.detached { [engine] in
            do {
                let result = try engine.removeText(from: image, atLocations: selectedBBoxes)
                return result
            } catch {
                print("[OCRViewModel] ❌ 文字移除錯誤: \(error.localizedDescription)")
                return nil
            }
        }.value

        if let newImage = processedImage {
            // 移除已刪除的詞彙
            var updatedBlocks = result.textBlocks
            for blockIdx in updatedBlocks.indices {
                for lineIdx in updatedBlocks[blockIdx].lines.indices {
                    updatedBlocks[blockIdx].lines[lineIdx].words.removeAll {
                        selectedWordIds.contains($0.id)
                    }
                }
                // 移除空行
                updatedBlocks[blockIdx].lines.removeAll { $0.words.isEmpty }
            }
            // 移除空區塊
            updatedBlocks.removeAll { $0.lines.isEmpty }

            scanResult = OCRScanResult(
                originalImage: newImage,
                dimensions: result.dimensions,
                textBlocks: updatedBlocks
            )
            selectedWordIds.removeAll()
            state = .complete
        } else {
            state = .error("文字移除失敗")
        }

        progress = 1.0
    }

    /// 替換選取的文字
    /// - Parameter newText: 新的文字內容
    func replaceSelectedText(with newText: String) async {
        guard let result = scanResult, !selectedWordIds.isEmpty else { return }
        guard let engine = engine, engine.isReady else {
            state = .error("OCR 引擎未就緒")
            return
        }

        // 保存編輯前快照
        saveSnapshot(description: "替換文字")

        state = .replacing
        progress = 0.5

        // 取得第一個選取詞彙的邊界框（簡化：以第一個為替換目標）
        guard let firstWord = result.textBlocks
            .flatMap({ $0.lines })
            .flatMap({ $0.words })
            .first(where: { selectedWordIds.contains($0.id) })
        else {
            state = .error("找不到選取的詞彙")
            return
        }

        let bbox = firstWord.boundingBox
        let bridgeBBox = OCRBoundingBox(
            topLeft: bbox.topLeft,
            topRight: bbox.topRight,
            bottomRight: bbox.bottomRight,
            bottomLeft: bbox.bottomLeft
        )

        let image = result.originalImage
        let processedImage: NSImage? = await Task.detached { [engine] in
            do {
                let result = try engine.replaceText(in: image,
                                                     atLocation: bridgeBBox,
                                                     withNewText: newText,
                                                     fontName: nil)
                return result
            } catch {
                print("[OCRViewModel] ❌ 文字替換錯誤: \(error.localizedDescription)")
                return nil
            }
        }.value

        if let newImage = processedImage {
            // 更新詞彙文字
            var updatedBlocks = result.textBlocks
            for blockIdx in updatedBlocks.indices {
                for lineIdx in updatedBlocks[blockIdx].lines.indices {
                    for wordIdx in updatedBlocks[blockIdx].lines[lineIdx].words.indices {
                        let word = updatedBlocks[blockIdx].lines[lineIdx].words[wordIdx]
                        if selectedWordIds.contains(word.id) {
                            updatedBlocks[blockIdx].lines[lineIdx].words[wordIdx].text = newText
                        }
                    }
                }
            }

            scanResult = OCRScanResult(
                originalImage: newImage,
                dimensions: result.dimensions,
                textBlocks: updatedBlocks
            )
            selectedWordIds.removeAll()
            state = .complete
        } else {
            state = .error("文字替換失敗")
        }

        progress = 1.0
    }

    // MARK: - 選取操作

    /// 切換詞彙選取狀態
    /// - Parameter wordId: 詞彙 ID
    func toggleWordSelection(_ wordId: UUID) {
        if selectedWordIds.contains(wordId) {
            selectedWordIds.remove(wordId)
        } else {
            selectedWordIds.insert(wordId)
        }
        // 同步更新模型中的 isSelected 狀態
        updateWordSelectionState()
    }

    /// 全選所有詞彙
    func selectAll() {
        guard let result = scanResult else { return }
        selectedWordIds = Set(
            result.textBlocks
                .flatMap { $0.lines }
                .flatMap { $0.words }
                .map { $0.id }
        )
        updateWordSelectionState()
    }

    /// 清除所有選取
    func clearSelection() {
        selectedWordIds.removeAll()
        updateWordSelectionState()
    }

    /// 匯出辨識文字到剪貼簿
    func exportText() {
        guard let text = scanResult?.fullText, !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        print("[OCRViewModel] 📋 已複製全文到剪貼簿（\(text.count) 字元）")
    }

    // MARK: - Undo/Redo

    /// 還原上一步操作
    func undo() {
        guard canUndo else { return }
        editHistoryIndex -= 1
        let snapshot = editHistory[editHistoryIndex]
        applySnapshot(snapshot)
        print("[OCRViewModel] ↩️ 還原: \(snapshot.description)")
    }

    /// 重做操作
    func redo() {
        guard canRedo else { return }
        editHistoryIndex += 1
        let snapshot = editHistory[editHistoryIndex]
        applySnapshot(snapshot)
        print("[OCRViewModel] ↪️ 重做: \(snapshot.description)")
    }

    // MARK: - 私有方法

    /// 執行 OCR 辨識
    private func performOCR(on image: NSImage) async {
        guard let engine = engine, engine.isReady else {
            state = .error("OCR 引擎未初始化，請確認模型檔案已正確放置。")
            errorMessage = "引擎未就緒。請檢查 models/ 目錄是否存在於 App Bundle 中。"
            return
        }

        // 在背景執行緒呼叫 C API
        let result: OCRResult? = await Task.detached { [engine] in
            do {
                let ocrResult = try engine.recognizeImage(image)
                return ocrResult
            } catch {
                print("[OCRViewModel] ❌ OCR 辨識錯誤: \(error.localizedDescription)")
                return nil
            }
        }.value

        progress = 0.8

        if let ocrResult = result {
            let scanResult = OCRScanResult.from(bridgeResult: ocrResult, originalImage: image)
            self.scanResult = scanResult

            // Build CanvasDocument layers for standard image
            var layers: [CanvasLayer] = []
            let bgLayer = CanvasLayer(
                layerId: "image_bg",
                type: .image,
                name: "原始影像底圖",
                boundingBox: BoundingBox(
                    topLeft: CGPoint(x: 0, y: scanResult.dimensions.height),
                    topRight: CGPoint(x: scanResult.dimensions.width, y: scanResult.dimensions.height),
                    bottomRight: CGPoint(x: scanResult.dimensions.width, y: 0),
                    bottomLeft: CGPoint(x: 0, y: 0)
                ),
                image: image
            )
            layers.append(bgLayer)
            
            var textId = 0
            for block in scanResult.textBlocks {
                for line in block.lines {
                    for word in line.words {
                        textId += 1
                        let layer = CanvasLayer(
                            layerId: "text_\(textId)",
                            type: .text,
                            name: "文字元件 \(textId)",
                            text: word.text,
                            boundingBox: word.boundingBox,
                            fontEstimate: word.fontEstimate
                        )
                        layers.append(layer)
                    }
                }
            }
            
            self.canvasDocument = CanvasDocument(
                name: "自訂影像畫布",
                dimensions: scanResult.dimensions,
                layers: layers
            )

            // 初始化編輯歷史
            editHistory = [EditSnapshot(textBlocks: scanResult.textBlocks, description: "初始辨識")]
            editHistoryIndex = 0

            state = .complete
            progress = 1.0
            print("[OCRViewModel] ✅ 辨識完成: \(scanResult.textBlocks.count) 區塊, \(scanResult.wordCount) 詞彙")
        } else {
            state = .error("OCR 辨識失敗")
            errorMessage = "無法辨識影像中的文字，請嘗試其他影像。"
        }
    }

    /// 保存編輯快照
    private func saveSnapshot(description: String) {
        guard let result = scanResult else { return }

        // 截斷 redo 歷史
        if editHistoryIndex < editHistory.count - 1 {
            editHistory = Array(editHistory.prefix(editHistoryIndex + 1))
        }

        let snapshot = EditSnapshot(textBlocks: result.textBlocks, description: description)
        editHistory.append(snapshot)
        editHistoryIndex = editHistory.count - 1
    }

    /// 套用快照
    private func applySnapshot(_ snapshot: EditSnapshot) {
        guard var result = scanResult else { return }
        result = OCRScanResult(
            id: result.id,
            originalImage: result.originalImage,
            dimensions: result.dimensions,
            textBlocks: snapshot.textBlocks
        )
        scanResult = result
        selectedWordIds.removeAll()
        updateWordSelectionState()
    }

    /// 同步模型中的 isSelected 狀態
    private func updateWordSelectionState() {
        guard let result = scanResult else { return }
        var updatedBlocks = result.textBlocks
        for blockIdx in updatedBlocks.indices {
            for lineIdx in updatedBlocks[blockIdx].lines.indices {
                for wordIdx in updatedBlocks[blockIdx].lines[lineIdx].words.indices {
                    let word = updatedBlocks[blockIdx].lines[lineIdx].words[wordIdx]
                    updatedBlocks[blockIdx].lines[lineIdx].words[wordIdx].isSelected =
                        selectedWordIds.contains(word.id)
                }
            }
        }
        // 只在有變動時更新，避免不必要的 SwiftUI 刷新
        if updatedBlocks != result.textBlocks {
            scanResult = OCRScanResult(
                id: result.id,
                originalImage: result.originalImage,
                dimensions: result.dimensions,
                textBlocks: updatedBlocks
            )
        }
    }

    /// 載入體驗簡報範本 (Onboarding UX)
    func loadSampleDocument() {
        state = .loading
        progress = 0.5
        
        let dimensions = CGSize(width: 1920, height: 1080)
        var layers: [CanvasLayer] = []
        
        // Background layer
        let bgLayer = CanvasLayer(
            layerId: "sample_bg",
            type: .image,
            name: "體驗簡報背景底圖",
            boundingBox: BoundingBox(
                topLeft: CGPoint(x: 0, y: 1080),
                topRight: CGPoint(x: 1920, y: 1080),
                bottomRight: CGPoint(x: 1920, y: 0),
                bottomLeft: CGPoint(x: 0, y: 0)
            )
        )
        layers.append(bgLayer)
        
        // Title Text layer
        let titleLayer = CanvasLayer(
            layerId: "sample_title",
            type: .text,
            name: "體驗標題文字",
            text: "離線文件圖層編輯器",
            boundingBox: BoundingBox(
                topLeft: CGPoint(x: 200, y: 780),
                topRight: CGPoint(x: 1720, y: 780),
                bottomRight: CGPoint(x: 1720, y: 930),
                bottomLeft: CGPoint(x: 200, y: 930)
            ),
            fontEstimate: FontEstimate(sizePx: 48, color: .darkGray, isBold: true)
        )
        layers.append(titleLayer)
        
        // Subtitle Text layer
        let subLayer = CanvasLayer(
            layerId: "sample_sub",
            type: .text,
            name: "體驗副標題文字",
            text: "全端側 AI 運算，保護商業隱私，維持零營運成本",
            boundingBox: BoundingBox(
                topLeft: CGPoint(x: 200, y: 580),
                topRight: CGPoint(x: 1720, y: 580),
                bottomRight: CGPoint(x: 1720, y: 680),
                bottomLeft: CGPoint(x: 200, y: 680)
            ),
            fontEstimate: FontEstimate(sizePx: 24, color: .gray, isBold: false)
        )
        layers.append(subLayer)
        
        // Vector Element layer
        let vectorLayer = CanvasLayer(
            layerId: "sample_vector",
            type: .vector,
            name: "體驗圖標元件",
            boundingBox: BoundingBox(
                topLeft: CGPoint(x: 860, y: 200),
                topRight: CGPoint(x: 1060, y: 200),
                bottomRight: CGPoint(x: 1060, y: 400),
                bottomLeft: CGPoint(x: 860, y: 400)
            )
        )
        layers.append(vectorLayer)
        
        self.canvasDocument = CanvasDocument(
            name: "體驗簡報範本.pptx",
            dimensions: dimensions,
            layers: layers
        )
        
        state = .complete
        progress = 1.0
        print("[OCRViewModel] ✅ 體驗簡報範本載入完成")
    }

    deinit {
        print("[OCRViewModel] 🗑️ 釋放 ViewModel 資源...")
    }
}
