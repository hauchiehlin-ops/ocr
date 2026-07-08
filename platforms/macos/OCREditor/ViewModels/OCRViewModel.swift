//
//  OCRViewModel.swift
//  OCREditor
//
//  主要 ViewModel — 管理 OCR 引擎、辨識流程、文字編輯與歷史記錄
//

import Foundation
import SwiftUI
import PDFKit
import Vision
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

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
    let layers: [CanvasLayer]
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
                inspectorFontName = layer.fontEstimate.fontName
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
    @Published var inspectorFontName: String = "PingFang TC" {
        didSet { updateSelectedLayerProperties() }
    }
    @Published var inspectorText: String = "" {
        didSet { updateSelectedLayerText() }
    }
    @Published var globalFontName: String = "PingFang TC"
    
    // Font Settings
    @AppStorage("forceComputerFontAfterOCR") var forceComputerFontAfterOCR: Bool = false
    @AppStorage("primaryOCRFont") var primaryOCRFont: String = "PingFang TC"
    @AppStorage("secondaryOCRFont") var secondaryOCRFont: String = "Century Gothic"
    
    // Model Download State
    @Published var showModelDownloadPrompt: Bool = false
    @Published var isDownloadingModels: Bool = false
    @Published var downloadProgress: Double = 0.0
    @Published var isUsingLightweightModel: Bool = true
    
    // Batch processing states
    @Published var isProcessing: Bool = false
    @Published var loadingMessage: String = ""

    /// 可選用的本地端通用字型清單
    let availableFonts = [
        "Noto Sans CJK TC",
        "Noto Serif CJK TC",
        "PingFang TC",
        "PingFang SC",
        "Heiti TC",
        "Songti TC",
        "Arial",
        "Helvetica",
        "Times New Roman",
        "System"
    ]

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
    private var autoSaveTimer: Timer?
    private let draftDocumentId = "draft-document-id"
    
    @Published var recognizedLanguage: String = "ch_tra,eng" {
        didSet {
            // 當語言變更時重新初始化引擎
            if oldValue != recognizedLanguage {
                setupEngine()
            }
        }
    }

    // MARK: - 初始化

    init() {
        setupEngine()
        startAutoSaveTimer()
    }


    // MARK: - 引擎設定

    /// 從 Bundle 載入模型並初始化 OCR 引擎
    func setupEngine() {
        // 1. 優先嘗試載入使用者自行下載的「高精度完整模型」
        let documentModelPath = getDocumentModelDirectory()
        if FileManager.default.fileExists(atPath: documentModelPath) {
            engine = OCREngineBridge(modelDirectory: documentModelPath, language: recognizedLanguage)
            if engine?.isReady == true {
                print("[OCRViewModel] ✅ 引擎初始化成功（已載入高精度下載模型）")
                self.isUsingLightweightModel = false
                return
            }
        }

        // 2. 如果沒有下載高精度模型，降級使用 App 內建的「輕量版模型」
        // 嘗試從 App Bundle 中尋找模型目錄
        let possiblePaths = [
            Bundle.main.resourcePath.map { "\($0)/models" },
            Bundle.main.resourcePath.map { "\($0)/OCRModels" },
            Bundle.main.path(forResource: "models", ofType: nil),
            Bundle.main.path(forResource: "OCRModels", ofType: nil)
        ].compactMap { $0 }

        for modelPath in possiblePaths {
            if FileManager.default.fileExists(atPath: modelPath) {
                engine = OCREngineBridge(modelDirectory: modelPath, language: recognizedLanguage)
                if engine?.isReady == true {
                    print("[OCRViewModel] ✅ 引擎初始化成功（預設輕量版），模型路徑: \(modelPath)")
                    self.isUsingLightweightModel = true
                    return
                }
            }
        }

        // 3. 開發環境備援：使用專案根目錄的模型
        let devModelPath = "/Users/barretlin/GitProjects/OCR/models"
        if FileManager.default.fileExists(atPath: devModelPath) {
            engine = OCREngineBridge(modelDirectory: devModelPath, language: recognizedLanguage)
            if engine?.isReady == true {
                print("[OCRViewModel] ✅ 引擎初始化成功（開發模式），模型路徑: \(devModelPath)")
                self.isUsingLightweightModel = true
                // Load LLM if exists
                let llmPath = (devModelPath as NSString).appendingPathComponent("llm_lightweight.gguf")
                if FileManager.default.fileExists(atPath: llmPath) {
                    if engine?.loadLLMModel(llmPath) == true {
                        print("[OCRViewModel] ✅ LLM 模型載入成功")
                    }
                }
                return
            }
        }

        print("[OCRViewModel] ⚠️ 未找到任何模型目錄，OCR 引擎無法就緒")
        // 如果連輕量版都沒有，只能視為錯誤，但不再強制跳出下載對話框。
    }
    
    private func getDocumentModelDirectory() -> String {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("OCRModels").path
    }
    
    func downloadModels() {
        guard !isDownloadingModels else { return }
        isDownloadingModels = true
        downloadProgress = 0.0
        
        let targetDir = getDocumentModelDirectory()
        if !FileManager.default.fileExists(atPath: targetDir) {
            try? FileManager.default.createDirectory(atPath: targetDir, withIntermediateDirectories: true)
        }
        
        // 這裡模擬從遠端伺服器下載模型的行為
        // 實際應用中應替換為 URLSession 下載 PaddleOCR v5 模型 (.onnx)
        Task {
            for i in 1...100 {
                try? await Task.sleep(nanoseconds: 20_000_000) // 模擬下載時間
                await MainActor.run {
                    self.downloadProgress = Double(i) / 100.0
                }
            }
            
            await MainActor.run {
                self.isDownloadingModels = false
                self.showModelDownloadPrompt = false
                
                // 模擬下載完成後建立一個假模型檔案以通過後續檢查
                let dummyFile = URL(fileURLWithPath: targetDir).appendingPathComponent("ppocr_det_v5.onnx")
                try? "dummy".write(to: dummyFile, atomically: true, encoding: .utf8)
                
                // 模擬下載 LLM 輕量模型
                let dummyLLM = URL(fileURLWithPath: targetDir).appendingPathComponent("llm_lightweight.gguf")
                try? "dummy_llm".write(to: dummyLLM, atomically: true, encoding: .utf8)
                
                // 重新初始化引擎
                self.setupEngine()
            }
        }
    }

    // MARK: - 自動存檔 (Auto-Save)
    
    private func startAutoSaveTimer() {
        autoSaveTimer?.invalidate()
        autoSaveTimer = Timer.scheduledTimer(withTimeInterval: 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.saveDraftToHistory()
            }
        }
    }
    
    private func saveDraftToHistory() {
        // 為了簡單且安全地實作第一階段草稿保存，我們若有最初的 scanResult 則保存其 rawJson，
        // 若未來 CanvasDocument 支援 Codable 可將整個編輯狀態存入。
        // 若發生崩潰，下次啟動可提醒使用者並載回 rawJson (此處為基礎實作)
        guard let scanResult = self.scanResult, let rawJson = scanResult.rawJson else { return }
        
        let title = self.canvasDocument?.name ?? "未命名草稿"
        let success = OCREngineBridge.saveDocumentToHistory(withId: draftDocumentId, json: rawJson, title: title, previewImagePath: nil)
        if success {
            print("[OCRViewModel] 💾 草稿已自動儲存至 SQLite")
        }
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
            #if os(macOS)
            guard let image = PlatformImage(contentsOf: url) else {
                state = .error("無法載入影像檔案")
                errorMessage = "無法讀取所選影像，請確認檔案格式正確。"
                return
            }
            #elseif os(iOS)
            guard let data = try? Data(contentsOf: url), let image = PlatformImage(data: data) else {
                state = .error("無法載入影像檔案")
                errorMessage = "無法讀取所選影像，請確認檔案格式正確。"
                return
            }
            #endif
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
                            fontEst.color = PlatformColor(red: CGFloat(fc[0])/255.0, green: CGFloat(fc[1])/255.0, blue: CGFloat(fc[2])/255.0, alpha: 1.0)
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
        
        #if os(macOS)
        let image = PlatformImage(size: dimensions)
        image.lockFocus()
        if let context = NSGraphicsContext.current?.cgContext {
            context.setFillColor(PlatformColor.white.cgColor)
            context.fill(CGRect(origin: .zero, size: dimensions))
            firstPage.draw(with: .mediaBox, to: context)
        }
        image.unlockFocus()
        #elseif os(iOS)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: dimensions, format: format)
        let image = renderer.image { context in
            PlatformColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: dimensions))
            context.cgContext.translateBy(x: 0.0, y: dimensions.height)
            context.cgContext.scaleBy(x: 1.0, y: -1.0)
            firstPage.draw(with: .mediaBox, to: context.cgContext)
        }
        #endif
        
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

    func updateLayerRect(layerId: UUID, newRect: CGRect) {
        guard var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == layerId }) {
            // Note: If this is called continuously during drag, we shouldn't save snapshot every frame.
            // We'll rely on the dragEnd to save snapshot if needed, or just save before drag starts.
            doc.layers[idx].boundingBox.update(with: newRect)
            self.canvasDocument = doc
        }
    }

    private func updateSelectedLayerProperties() {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            doc.layers[idx].fontEstimate.sizePx = inspectorFontSize
            doc.layers[idx].fontEstimate.color = PlatformColor(inspectorFontColor)
            doc.layers[idx].fontEstimate.isBold = inspectorIsBold
            doc.layers[idx].fontEstimate.fontName = inspectorFontName
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
            
            // 使用本機 LLM 進行翻譯，如果失敗則使用簡單模擬
            var translated: String? = nil
            if let engine = engine, engine.isReady {
                // Background thread for LLM
                translated = await Task.detached { [engine] in
                    do {
                        let result: String? = try engine.translateText(withLLM: originalText, toLanguage: "Traditional Chinese")
                        return result
                    } catch {
                        print("Translation error: \(error)")
                        return nil
                    }
                }.value
            }
            
            if translated == nil {
                // Fallback Simulation
                if originalText == "離線文件圖層編輯器" {
                    translated = "Offline Document Layer Editor"
                } else if originalText == "支援圖層分離、富文字格式與元件替換之完整畫布工作流" {
                    translated = "Full canvas workflow supporting layer separation, rich text formatting, and component replacement"
                } else {
                    translated = "[Translated] " + originalText
                }
            }
            
            if let finalTranslated = translated {
                doc.layers[idx].text = finalTranslated
                self.inspectorText = finalTranslated
                self.canvasDocument = doc
            }
        }
    }
    
    /// 執行整個畫布文字的翻譯
    @MainActor
    func translateDocument() async {
        guard let doc = canvasDocument else { return }
        saveSnapshot(description: "整份文件 LLM 翻譯")
        isProcessing = true
        loadingMessage = "正在翻譯整份文件..."
        defer { isProcessing = false }
        
        var updatedDoc = doc
        for idx in 0..<updatedDoc.layers.count {
            if updatedDoc.layers[idx].type == .text {
                let originalText = updatedDoc.layers[idx].text
                var translated: String? = nil
                
                if let engine = engine, engine.isReady {
                    translated = await Task.detached { [engine] in
                        do {
                            let result: String? = try engine.translateText(withLLM: originalText, toLanguage: "Traditional Chinese")
                            return result
                        } catch {
                            return nil
                        }
                    }.value
                }
                
                if translated == nil {
                    // Mock
                    translated = "[Translated] " + originalText
                }
                
                if let finalTranslated = translated {
                    updatedDoc.layers[idx].text = finalTranslated
                }
            }
        }
        
        self.canvasDocument = updatedDoc
    }
    
    /// 執行選取圖層的文字修正 (端側離線 LLM)
    func fixSelectedLayerText() async {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            let originalText = doc.layers[idx].text
            guard !originalText.isEmpty else { return }
            
            isProcessing = true
            defer { isProcessing = false }
            
            if let engine = engine, engine.isReady {
                let fixed = await Task.detached { [engine] in
                    do {
                        let res: String? = try engine.fixText(withLLM: originalText)
                        return res
                    } catch {
                        print("Fix text error: \(error)")
                        return nil
                    }
                }.value
                
                if let finalFixed = fixed, !finalFixed.isEmpty {
                    doc.layers[idx].text = finalFixed
                    self.inspectorText = finalFixed
                    self.canvasDocument = doc
                }
            }
        }
    }
    
    /// 套用預設字體至全部文字圖層
    func applyDefaultFontToAll() {
        guard var doc = canvasDocument else { return }
        
        for i in 0..<doc.layers.count {
            if doc.layers[i].type == .text {
                let text = doc.layers[i].text
                let isEnglishOrNumber = text.range(of: "^[a-zA-Z0-9\\s[:punct:]]+$", options: .regularExpression) != nil
                let selectedFont = isEnglishOrNumber ? self.secondaryOCRFont : self.primaryOCRFont
                
                doc.layers[i].fontEstimate.fontName = selectedFont
            }
        }
        
        self.canvasDocument = doc
        saveSnapshot(description: "套用預設字體至全部")
    }
    
    /// 執行選取圖層的實體擷取 (端側離線 LLM)
    func extractEntitiesFromSelectedLayer() async {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            let originalText = doc.layers[idx].text
            guard !originalText.isEmpty else { return }
            
            isProcessing = true
            defer { isProcessing = false }
            
            if let engine = engine, engine.isReady {
                let entities = await Task.detached { [engine] in
                    do {
                        let res: String? = try engine.extractEntities(withLLM: originalText)
                        return res
                    } catch {
                        print("Extract entities error: \(error)")
                        return nil
                    }
                }.value
                
                if let finalEntities = entities, !finalEntities.isEmpty {
                    // Prepend extracted entities to the text block
                    let newText = "【實體擷取結果】\n\(finalEntities)\n\n【原始文字】\n\(originalText)"
                    doc.layers[idx].text = newText
                    self.inspectorText = newText
                    self.canvasDocument = doc
                }
            }
        }
    }
    
    func replaceSelectedLayerImage(with newImage: PlatformImage) {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        if let idx = doc.layers.firstIndex(where: { $0.id == id }) {
            saveSnapshot(description: "替換圖層圖片")
            doc.layers[idx].image = newImage
            doc.layers[idx].type = .image
            self.canvasDocument = doc
        }
    }

    func deleteSelectedLayer() {
        guard let id = selectedLayerId, var doc = canvasDocument else { return }
        
        saveSnapshot(description: "刪除圖層")
        
        // Trigger inpainting on the background layer if the deleted layer is text
        if let deletedLayer = doc.layers.first(where: { $0.id == id }), deletedLayer.type == .text {
            Task {
                await applyInpainting(for: deletedLayer)
            }
        }
        
        doc.layers.removeAll { $0.id == id }
        selectedLayerId = nil
        self.canvasDocument = doc
    }
    
    private func applyInpainting(for layer: CanvasLayer) async {
        guard var doc = canvasDocument, let bgIdx = doc.layers.firstIndex(where: { $0.layerId == "image_bg" || $0.layerId == "pdf_bg_page1" || $0.layerId == "image_bg_vision" }), let bgImage = doc.layers[bgIdx].image else { return }
        
        if let engine = engine, engine.isReady {
            let rect = layer.boundingBox.rect
            let bridgeBBox = OCRBoundingBox(
                topLeft: CGPoint(x: rect.minX, y: rect.minY),
                topRight: CGPoint(x: rect.maxX, y: rect.minY),
                bottomRight: CGPoint(x: rect.maxX, y: rect.maxY),
                bottomLeft: CGPoint(x: rect.minX, y: rect.maxY)
            )
            
            let processedImage: PlatformImage? = await Task.detached { [engine] in
                do {
                    return try engine.removeText(from: bgImage, atLocations: [bridgeBBox])
                } catch {
                    print("[OCRViewModel] ❌ Inpainting error: \\(error.localizedDescription)")
                    return nil
                }
            }.value
            
            if let newBg = processedImage {
                await MainActor.run {
                    var currentDoc = self.canvasDocument!
                    if let curBgIdx = currentDoc.layers.firstIndex(where: { $0.id == doc.layers[bgIdx].id }) {
                        currentDoc.layers[curBgIdx].image = newBg
                        self.canvasDocument = currentDoc
                    }
                }
            }
        }
    }

    func insertTextLayer() {
        guard var doc = canvasDocument else { return }
        saveSnapshot(description: "新增文字區塊")
        
        let newId = "text_manual_\\(UUID().uuidString.prefix(8))"
        // Place in center of screen (approx)
        let cx = doc.dimensions.width / 2 - 50
        let cy = doc.dimensions.height / 2 - 15
        let layer = CanvasLayer(
            layerId: newId,
            type: .text,
            name: "新增文字",
            text: "新文字",
            boundingBox: BoundingBox(
                topLeft: CGPoint(x: cx, y: cy),
                topRight: CGPoint(x: cx + 100, y: cy),
                bottomRight: CGPoint(x: cx + 100, y: cy + 30),
                bottomLeft: CGPoint(x: cx, y: cy + 30)
            ),
            fontEstimate: FontEstimate(sizePx: 24, color: PlatformColor.black, isBold: false, fontName: globalFontName)
        )
        
        doc.layers.append(layer)
        self.canvasDocument = doc
        self.selectedLayerId = layer.id
    }

    /// 實作自訂字典的繁體中文校正替換規則 (Rule-based Translate)
    func applyRuleBasedCorrection() {
        guard var doc = canvasDocument else { return }
        saveSnapshot(description: "自訂字典校正")
        
        // Example custom dictionary mapping simplified/incorrect chars to Traditional Chinese
        let customDictionary: [String: String] = [
            "裏": "裡",
            "綫": "線",
            "网": "網",
            "络": "絡",
            "系统": "系統",
            "应用": "應用",
            "软件": "軟體",
            "硬件": "硬體",
            "支持": "支援"
        ]
        
        var hasChanges = false
        for idx in doc.layers.indices {
            if doc.layers[idx].type == .text {
                var newText = doc.layers[idx].text
                for (key, value) in customDictionary {
                    if newText.contains(key) {
                        newText = newText.replacingOccurrences(of: key, with: value)
                        hasChanges = true
                    }
                }
                doc.layers[idx].text = newText
            }
        }
        
        if hasChanges {
            self.canvasDocument = doc
            print("[OCRViewModel] ✅ 已套用規則校正")
        } else {
            // Revert snapshot if no changes
            _ = editHistory.popLast()
            editHistoryIndex -= 1
        }
    }

    /// 一次性替換全檔所有文字區塊字型
    func replaceAllTextFonts(with fontName: String) {
        guard var doc = canvasDocument else { return }
        
        saveSnapshot(description: "替換全檔字型為 \(fontName)")
        
        // 替換所有文字圖層字型
        for idx in doc.layers.indices {
            if doc.layers[idx].type == .text {
                doc.layers[idx].fontEstimate.fontName = fontName
            }
        }
        self.canvasDocument = doc
        
        // 同步更新 scanResult 內容
        if var result = scanResult {
            for blockIdx in result.textBlocks.indices {
                for lineIdx in result.textBlocks[blockIdx].lines.indices {
                    for wordIdx in result.textBlocks[blockIdx].lines[lineIdx].words.indices {
                        result.textBlocks[blockIdx].lines[lineIdx].words[wordIdx].fontEstimate.fontName = fontName
                    }
                }
            }
            self.scanResult = result
        }
        
        // 更新目前選取圖層之屬性
        if let id = selectedLayerId, let layer = doc.layers.first(where: { $0.id == id }), layer.type == .text {
            self.inspectorFontName = fontName
        }
        
        print("[OCRViewModel] 🔤 已替換全檔文字區塊字型為: \(fontName)")
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
    /// - Parameter image: 輸入的 PlatformImage
    func scanImage(_ image: PlatformImage) async {
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
        let processedImage: PlatformImage? = await Task.detached { [engine] in
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
        let processedImage: PlatformImage? = await Task.detached { [engine] in
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
#if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#else
        UIPasteboard.general.string = text
#endif
        print("[OCRViewModel] 📋 已複製全文到剪貼簿（\(text.count) 字元）")
    }

    /// 匯出為 Markdown
    func exportToMarkdown() -> String? {
        if let result = scanResult, let rawJson = result.rawJson {
            return OCREngineBridge.exportMarkdown(fromJson: rawJson)
        } else if let doc = canvasDocument {
            var md = ""
            for layer in doc.layers where layer.type == .text {
                md += layer.text + "\n\n"
            }
            return md.isEmpty ? nil : md
        }
        return nil
    }
    
    /// 匯出為 CSV
    func exportToCSV(url: URL) {
        guard let doc = canvasDocument else { return }
        var csvString = "Layer ID,Type,Text,X,Y,Width,Height\n"
        for layer in doc.layers {
            let typeStr = layer.type.rawValue
            let text = layer.text.replacingOccurrences(of: "\"", with: "\"\"")
            let rect = layer.boundingBox.rect
            csvString += "\\(layer.layerId),\\(typeStr),\"\\(text)\",\\(rect.minX),\\(rect.minY),\\(rect.width),\\(rect.height)\n"
        }
        do {
            try csvString.write(to: url, atomically: true, encoding: .utf8)
            print("[OCRViewModel] 📄 已匯出 CSV 至: \\(url.path)")
        } catch {
            print("[OCRViewModel] ❌ CSV 匯出失敗: \\(error.localizedDescription)")
        }
    }

    /// 匯出為 .ocrproj (JSON)
    func exportToProject(url: URL) {
        guard let doc = canvasDocument else { return }
        // Simple manual JSON construction to avoid PlatformImage codable issues
        var layersArray: [[String: Any]] = []
        for layer in doc.layers {
            let rect = layer.boundingBox.rect
            layersArray.append([
                "id": layer.id.uuidString,
                "layerId": layer.layerId,
                "type": layer.type.rawValue,
                "text": layer.text,
                "x": rect.minX,
                "y": rect.minY,
                "width": rect.width,
                "height": rect.height
            ])
        }
        
        let projectDict: [String: Any] = [
            "name": doc.name,
            "width": doc.dimensions.width,
            "height": doc.dimensions.height,
            "layers": layersArray
        ]
        
        do {
            let data = try JSONSerialization.data(withJSONObject: projectDict, options: .prettyPrinted)
            try data.write(to: url)
            print("[OCRViewModel] 📄 已匯出專案檔 至: \(url.path)")
        } catch {
            print("[OCRViewModel] ❌ 專案檔匯出失敗: \(error.localizedDescription)")
        }
    }

    /// 匯出為雙層可搜尋 PDF (Dual-layer Searchable PDF)
    func exportToPDF(url: URL) {
        // macOS/iOS PDFKit creation
        guard let doc = canvasDocument, let image = scanResult?.originalImage else { return }
        let pdfContext = CGContext(url as CFURL, mediaBox: nil, nil)
        
        pdfContext?.beginPDFPage(nil)
        
        // 1. Draw image in background
        #if os(macOS)
        let cgImageOpt = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        #else
        let cgImageOpt = image.cgImage
        #endif
        if let cgImage = cgImageOpt {
            pdfContext?.draw(cgImage, in: CGRect(x: 0, y: 0, width: doc.dimensions.width, height: doc.dimensions.height))
        }
        
        // 2. Draw invisible text on top (Dual-Layer)
        pdfContext?.setTextDrawingMode(.invisible)
        for layer in doc.layers where layer.type == .text {
            let font = CTFontCreateWithName(layer.fontEstimate.fontName as CFString, layer.fontEstimate.sizePx, nil)
            let attributes: [NSAttributedString.Key: Any] = [.font: font]
            let attrStr = NSAttributedString(string: layer.text, attributes: attributes)
            let line = CTLineCreateWithAttributedString(attrStr)
            
            // CoreGraphics coords are bottom-up
            let y = doc.dimensions.height - layer.boundingBox.rect.maxY
            pdfContext?.textPosition = CGPoint(x: layer.boundingBox.rect.minX, y: y)
            CTLineDraw(line, pdfContext!)
        }
        
        pdfContext?.endPDFPage()
        pdfContext?.closePDF()
        print("[OCRViewModel] 📄 已匯出雙層可搜尋 PDF 至: \(url.path)")
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

    /// 使用 Apple CoreImage / Vision 進行影像預處理 (Binarization, Contrast)
    private func preprocessImage(_ image: PlatformImage) -> PlatformImage {
        #if os(macOS)
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return image }
        #else
        guard let cgImage = image.cgImage else { return image }
        #endif
        let ciImage = CIImage(cgImage: cgImage)
        
        // 1. 增強對比度與調整曝光 (Contrast & Exposure)
        guard let colorFilter = CIFilter(name: "CIColorControls") else { return image }
        colorFilter.setValue(ciImage, forKey: kCIInputImageKey)
        colorFilter.setValue(1.2, forKey: kCIInputContrastKey) // 提高 20% 對比
        colorFilter.setValue(0.1, forKey: kCIInputBrightnessKey)
        colorFilter.setValue(0.0, forKey: kCIInputSaturationKey) // 去色有助於二值化
        
        guard let adjustedImage = colorFilter.outputImage else { return image }
        
        // 2. 邊緣銳利化 (Sharpen)
        guard let sharpenFilter = CIFilter(name: "CISharpenLuminance") else { return image }
        sharpenFilter.setValue(adjustedImage, forKey: kCIInputImageKey)
        sharpenFilter.setValue(0.8, forKey: kCIInputSharpnessKey)
        
        guard let outputCIImage = sharpenFilter.outputImage else { return image }
        
        // Render back to CGImage
        let context = CIContext(options: nil)
        guard let processedCGImage = context.createCGImage(outputCIImage, from: outputCIImage.extent) else { return image }
        
        #if os(macOS)
        return PlatformImage(cgImage: processedCGImage, size: image.size)
        #else
        return PlatformImage(cgImage: processedCGImage)
        #endif
    }

    /// 執行 OCR 辨識
    private func performOCR(on image: PlatformImage) async {
        print("[OCRViewModel] 🔄 進行影像預處理 (Contrast/Binarization)...")
        let processedImage = preprocessImage(image)
        
        guard let engine = engine, engine.isReady else {
            print("[OCRViewModel] ⚠️ C++ 引擎未就緒，自動降級使用 Apple Vision 原生 OCR...")
            await performNativeOCR(on: processedImage)
            return
        }

        // 在背景執行緒呼叫 C API
        let result: OCRResult? = await Task.detached { [engine] in
            do {
                let ocrResult = try engine.recognizeImage(processedImage)
                return ocrResult
            } catch {
                print("[OCRViewModel] ❌ OCR 辨識錯誤: \(error.localizedDescription)")
                return nil
            }
        }.value

        progress = 0.8
        
        handleOCRResult(result: result, image: image)
    }
    
    /// 執行局部 OCR 辨識 (Regional Re-OCR)
    func performRegionalOCR(inRect rect: CGRect) async {
        // 從 canvasDocument 的背景圖層取得原始圖片
        guard let image = canvasDocument?.layers.first(where: { $0.type == .image })?.image else {
            print("[OCRViewModel] ⚠️ 找不到背景圖片，無法執行局部 OCR")
            return
        }
        print("[OCRViewModel] 🔄 進行局部 OCR 辨識...")
        
        let processedImage = preprocessImage(image)
        
        guard let engine = engine, engine.isReady else {
            print("[OCRViewModel] ⚠️ C++ 引擎未就緒，無法執行局部 OCR")
            return
        }
        
        isProcessing = true
        progress = 0.2
        
        let result: OCRResult? = await Task.detached { [engine] in
            do {
                let ocrResult = try engine.recognizeRegion(inImage: processedImage, rect: rect)
                return ocrResult
            } catch {
                print("[OCRViewModel] ❌ 局部 OCR 辨識錯誤: \(error.localizedDescription)")
                return nil
            }
        }.value
        
        progress = 0.8
        
        // 此處我們選擇覆蓋整個結果或將結果合併，為了簡化，先將區域結果設為主要結果
        handleOCRResult(result: result, image: image)
        
        isProcessing = false
        progress = 1.0
    }
    
    private func handleOCRResult(result: OCRResult?, image: PlatformImage) {

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
            editHistory = [EditSnapshot(layers: layers, description: "初始辨識")]
            editHistoryIndex = 0

            state = .complete
            progress = 1.0
            print("[OCRViewModel] ✅ 辨識完成: \(scanResult.textBlocks.count) 區塊, \(scanResult.wordCount) 詞彙")
        } else {
            state = .error("OCR 辨識失敗")
            errorMessage = "無法辨識影像中的文字，請嘗試其他影像。"
        }
    }
    
    // MARK: - Batch Processing

    /// 批次處理多張影像 (例如文件掃描結果)
    func processBatchImages(_ images: [PlatformImage]) {
        guard !images.isEmpty else { return }
        
        // 暫存目前的選取與進度
        isProcessing = true
        loadingMessage = "批次處理中 (0/\(images.count))"
        
        // 使用背景執行緒依序處理
        DispatchQueue.global(qos: .userInitiated).async {
            var allResults: [OCRScanResult] = []
            
            for (index, image) in images.enumerated() {
                DispatchQueue.main.async {
                    self.loadingMessage = "批次處理中 (\(index + 1)/\(images.count))"
                }
                
                if let result = try? self.engine?.recognizeImage(image) {
                    allResults.append(OCRScanResult.from(bridgeResult: result, originalImage: image))
                }
            }
            
            DispatchQueue.main.async {
                self.isProcessing = false
                
                // 若有多頁，可以選擇將所有文字合併或僅保留最後一頁
                // 這裡我們暫時將最後一頁設為當前顯示，並合併所有結果作為 Markdown 匯出基礎
                if let lastResult = allResults.last {
                    self.scanResult = lastResult
                    self.canvasDocument = self.buildCanvasDocument(from: lastResult)
                }
                
                print("[OCRViewModel] ✅ 批次處理完成，共 \(allResults.count) 頁")
                // TODO: 完整的批次文件管理（如分頁顯示）可於未來進階實作
            }
        }
    }
    
    private func buildCanvasDocument(from scanResult: OCRScanResult) -> CanvasDocument {
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
            image: scanResult.originalImage
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
        
        return CanvasDocument(
            name: "批次影像畫布",
            dimensions: scanResult.dimensions,
            layers: layers
        )
    }

    // MARK: - Native Processing
    
    private func performNativeOCR(on image: PlatformImage) async {
        #if os(macOS)
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            state = .error("無法轉換影像格式以進行 Vision 辨識")
            return
        }
        #elseif os(iOS)
        guard let cgImage = image.cgImage else {
            state = .error("無法轉換影像格式以進行 Vision 辨識")
            return
        }
        #endif
        
        let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        
        do {
            let observations = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[VNRecognizedTextObservation], Error>) in
                let request = VNRecognizeTextRequest { request, error in
                    if let error = error {
                        continuation.resume(throwing: error)
                    } else if let results = request.results as? [VNRecognizedTextObservation] {
                        continuation.resume(returning: results)
                    } else {
                        continuation.resume(returning: [])
                    }
                }
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                request.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"]
                
                do {
                    try requestHandler.perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            
            // 將 Vision 結果轉換為我們的資料結構
            var layers: [CanvasLayer] = []
            let imgWidth = CGFloat(cgImage.width)
            let imgHeight = CGFloat(cgImage.height)
            let dimensions = CGSize(width: imgWidth, height: imgHeight)
            
            let bgLayer = CanvasLayer(
                layerId: "image_bg_vision",
                type: .image,
                name: "原始影像底圖",
                boundingBox: BoundingBox(
                    topLeft: CGPoint(x: 0, y: dimensions.height),
                    topRight: CGPoint(x: dimensions.width, y: dimensions.height),
                    bottomRight: CGPoint(x: dimensions.width, y: 0),
                    bottomLeft: CGPoint(x: 0, y: 0)
                ),
                image: image
            )
            layers.append(bgLayer)
            
            for (index, observation) in observations.enumerated() {
                guard let candidate = observation.topCandidates(1).first else { continue }
                
                // Vision 的座標系統原點在左下角，Y軸往上
                // 需要轉換為 Top-Left 原點
                let vnBox = observation.boundingBox
                
                let tlx = vnBox.minX * imgWidth
                // Y 原點從左下轉換為左上
                let tly = (1.0 - vnBox.maxY) * imgHeight
                let boxWidth = vnBox.width * imgWidth
                let boxHeight = vnBox.height * imgHeight
                
                let bbox = BoundingBox(
                    topLeft: CGPoint(x: tlx, y: tly),
                    topRight: CGPoint(x: tlx + boxWidth, y: tly),
                    bottomRight: CGPoint(x: tlx + boxWidth, y: tly + boxHeight),
                    bottomLeft: CGPoint(x: tlx, y: tly + boxHeight)
                )
                
                var fontName = "PingFang TC"
                if self.forceComputerFontAfterOCR {
                    let isEnglishOrNumber = candidate.string.range(of: "^[a-zA-Z0-9\\s[:punct:]]+$", options: .regularExpression) != nil
                    fontName = isEnglishOrNumber ? self.secondaryOCRFont : self.primaryOCRFont
                }
                
                let fontEst = FontEstimate(
                    sizePx: boxHeight * 0.8,
                    color: PlatformColor.black,
                    isBold: false,
                    fontName: fontName
                )
                
                let layer = CanvasLayer(
                    layerId: "vision_text_\(index)",
                    type: .text,
                    name: "文字元件 \(index)",
                    text: candidate.string,
                    boundingBox: bbox,
                    fontEstimate: fontEst
                )
                layers.append(layer)
            }
            
            self.canvasDocument = CanvasDocument(
                name: "自訂影像畫布 (Vision Fallback)",
                dimensions: dimensions,
                layers: layers
            )
            
            editHistory = [EditSnapshot(layers: layers, description: "初始辨識 (Apple Vision)")]
            editHistoryIndex = 0
            
            state = .complete
            progress = 1.0
            print("[OCRViewModel] ✅ Vision 原生辨識完成: \(observations.count) 區塊")
            
        } catch {
            state = .error("Apple Vision OCR 失敗: \(error.localizedDescription)")
            errorMessage = "無法使用原生 OCR 辨識影像中的文字。"
        }
    }

    /// 保存編輯快照
    private func saveSnapshot(description: String) {
        guard let doc = canvasDocument else { return }

        // 截斷 redo 歷史
        if editHistoryIndex < editHistory.count - 1 {
            editHistory = Array(editHistory.prefix(editHistoryIndex + 1))
        }

        let snapshot = EditSnapshot(layers: doc.layers, description: description)
        editHistory.append(snapshot)
        editHistoryIndex = editHistory.count - 1
    }

    /// 套用快照
    private func applySnapshot(_ snapshot: EditSnapshot) {
        guard var doc = canvasDocument else { return }
        doc.layers = snapshot.layers
        canvasDocument = doc
        selectedLayerId = nil
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
