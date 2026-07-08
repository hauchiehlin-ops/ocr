//
//  ContentView.swift
//  OCREditor
//
//  主介面 — NavigationSplitView 配置：左側圖層面板 + 中間多圖層畫布 + 右側屬性控制區
//

import SwiftUI
import UniformTypeIdentifiers
import PDFKit

// MARK: - Helper Structs
enum GuideOrientation {
    case horizontal, vertical
}

struct GuideLine: Identifiable {
    let id = UUID()
    let orientation: GuideOrientation
    let position: CGFloat
}

// MARK: - ContentView

struct ContentView: View {
#if os(iOS)
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
#endif
    @StateObject private var viewModel = OCRViewModel()
    @State private var isFileImporterPresented = false
    @State private var isImageReplacerPresented = false
    @State private var isScannerPresented = false
    @State private var isSidebarPresented = false
    @State private var hoveredLayerId: UUID? = nil
    @State private var sidebarWidth: CGFloat = 300
    @State private var inspectorWidth: CGFloat = 320
    @State private var canvasZoom: CGFloat = 1.0
    @State private var currentZoom: CGFloat = 0.0

    @State private var draggingLayerId: UUID? = nil
    @State private var dragOffset: CGSize = .zero
    @State private var activeGuides: [GuideLine] = []

    // Regional Re-OCR Selection
    @State private var isSelectingRegion = false
    @State private var selectionStart: CGPoint?
    @State private var selectionCurrent: CGPoint?

    var body: some View {
        Group {
#if os(iOS)
        if horizontalSizeClass == .compact {
            // iPhone 佈局：以畫布為主，側邊欄改為 Bottom Sheet 或 Toolbar 按鈕
            NavigationStack {
                canvasArea
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .toolbar {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Button {
                                isSidebarPresented = true
                            } label: {
                                Image(systemName: "sidebar.left")
                            }
                        }
                        toolbarContent
                    }
                    .sheet(isPresented: $isSidebarPresented) {
                        NavigationStack {
                            sidebarContent
                                .navigationTitle("圖層與狀態")
                                .navigationBarTitleDisplayMode(.inline)
                                .toolbar {
                                    ToolbarItem(placement: .cancellationAction) {
                                        Button("完成") { isSidebarPresented = false }
                                    }
                                }
                        }
                        .presentationDetents([.medium, .large])
                    }
            }
        } else {
            // iPad 佈局：三欄式 NavigationSplitView
            NavigationSplitView {
                sidebarContent
                    .navigationSplitViewColumnWidth(min: 250, ideal: sidebarWidth, max: 350)
            } detail: {
                HStack(spacing: 0) {
                    canvasArea
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .toolbar {
                toolbarContent
            }
        }
#else
        // macOS 佈局：三欄式 NavigationSplitView
        NavigationSplitView {
            sidebarContent
                .navigationSplitViewColumnWidth(min: 250, ideal: sidebarWidth, max: 350)
        } detail: {
            HStack(spacing: 0) {
                // 中間主畫布區域
                canvasArea
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                
                Divider()
                
                // 右側屬性面板區域
                inspectorArea
                    .frame(width: inspectorWidth)
                    .background(Color(platformColor: PlatformColor.themeWindowBackground))
            }
        }
        .toolbar {
            toolbarContent
        }
#endif
        }
        #if os(iOS)
        .sheet(isPresented: Binding(
            get: { viewModel.selectedLayerId != nil },
            set: { if !$0 { viewModel.selectedLayerId = nil } }
        )) {
            NavigationStack {
                inspectorArea
                    .background(Color(platformColor: PlatformColor.themeWindowBackground))
                    .navigationTitle("屬性")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("關閉") { viewModel.selectedLayerId = nil }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
        #endif
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: supportedFileTypes,
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
        .fileImporter(
            isPresented: $isImageReplacerPresented,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in
            handleImageReplaceImport(result)
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $isScannerPresented) {
            DocumentScannerView(isPresented: $isScannerPresented) { images in
                viewModel.processBatchImages(images)
            }
        }
        #endif
        .frame(minWidth: 1100, minHeight: 750)
        .alert("錯誤", isPresented: showingError) {
            Button("確定", role: .cancel) {
                viewModel.errorMessage = nil
            }
        } message: {
            Text(viewModel.errorMessage ?? "發生未知錯誤")
        }
        .overlay(
            Group {
                if viewModel.isDownloadingModels {
                    ZStack {
                        Color.black.opacity(0.4)
                            .ignoresSafeArea()
                        
                        VStack(spacing: 20) {
                            Text("正在下載 AI 模型...")
                                .font(.headline)
                            
                            ProgressView(value: viewModel.downloadProgress)
                                .progressViewStyle(.linear)
                                .frame(width: 200)
                            
                            Text("\(Int(viewModel.downloadProgress * 100))%")
                                .font(.caption)
                        }
                        .padding(30)
                        .background(Color(platformColor: PlatformColor.themeWindowBackground))
                        .cornerRadius(12)
                        .shadow(radius: 20)
                    }
                }
            }
        )
        .alert("下載高精度 AI 模型", isPresented: $viewModel.showModelDownloadPrompt) {
            Button("立即下載") {
                viewModel.downloadModels()
            }
            Button("稍後再說", role: .cancel) {
                // User chose to stick with the lightweight model
            }
        } message: {
            Text("為了提供最佳的文字辨識效果，建議下載高精度 AI 模型 (約 50MB)。\n若選擇稍後下載，將暫時使用內建的輕量級模型。")
        }
        .onAppear {
            // Check for model status on first view appearance
            if !UserDefaults.standard.bool(forKey: "hasDownloadedHighAccuracyModel") && viewModel.isUsingLightweightModel {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    viewModel.showModelDownloadPrompt = true
                }
            }
        }
    }

    // MARK: - 支援的所有文件格式

    private var supportedFileTypes: [UTType] {
        var types: [UTType] = [.png, .jpeg, .tiff, .bmp, .gif, .heic, .pdf]
        if let pptxType = UTType(filenameExtension: "pptx") {
            types.append(pptxType)
        }
        return types
    }

    // MARK: - 錯誤提示綁定

    private var showingError: Binding<Bool> {
        Binding(
            get: { viewModel.errorMessage != nil },
            set: { if !$0 { viewModel.errorMessage = nil } }
        )
    }
}

// MARK: - 左側圖層面板 (Sidebar)

extension ContentView {
    @ViewBuilder
    private var sidebarContent: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    statusView
                        .padding(.vertical, 4)
                } header: {
                    Text("Document Status")
                        .font(.headline)
                }
                
                if let doc = viewModel.canvasDocument {
                    Section {
                        ForEach(doc.layers) { layer in
                            HStack {
                                Image(systemName: iconForLayer(layer.type))
                                    .foregroundColor(.secondary)
                                    .frame(width: 20)
                                
                                Text(layer.type == .text ? (layer.text.isEmpty ? layer.name : layer.text) : layer.name)
                                    .font(.body)
                                    .lineLimit(1)
                                
                                Spacer()
                                
                                if layer.type == .text {
                                    Text("\(Int(layer.fontEstimate.sizePx))px")
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                }
                            }
                            .contentShape(Rectangle())
                            .padding(.vertical, 4)
                            .listRowSelected(viewModel.selectedLayerId == layer.id)
                            .onTapGesture {
                                viewModel.selectedLayerId = layer.id
                            }
                        }
                    }
                } else {
                    VStack(spacing: 12) {
                        Spacer()
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 40))
                            .foregroundColor(.secondary.opacity(0.4))
                        Text("尚未載入文件")
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .listStyle(.sidebar)
            
            Divider()
            
            // 匯入檔案按鈕
            Button {
                isFileImporterPresented = true
            } label: {
                Label("開啟新檔案/簡報", systemImage: "arrow.down.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding()
        }
    }
    
    private func iconForLayer(_ type: CanvasLayerType) -> String {
        switch type {
        case .text: return "paragraphsign"
        case .image: return "photo"
        case .vector: return "triangle.fill"
        }
    }
    
    @ViewBuilder
    private var statusView: some View {
        HStack {
            if viewModel.state.isProcessing {
                ProgressView()
                    .controlSize(.small)
                    .padding(.trailing, 4)
            } else {
                Image(systemName: statusIcon)
                    .foregroundColor(statusColor)
            }
            Text(viewModel.state.displayText)
                .font(.callout)
                .foregroundColor(.secondary)
        }
        if viewModel.state.isProcessing {
            ProgressView(value: viewModel.progress)
                .progressViewStyle(.linear)
        }
    }

    private var statusIcon: String {
        switch viewModel.state {
        case .idle:     return "circle"
        case .complete: return "checkmark.circle.fill"
        case .error:    return "exclamationmark.triangle.fill"
        default:        return "circle"
        }
    }

    private var statusColor: Color {
        switch viewModel.state {
        case .complete: return .green
        case .error:    return .red
        default:        return .secondary
        }
    }
}

// MARK: - 中間畫布區域 (Canvas)

extension ContentView {
    @ViewBuilder
    private var canvasArea: some View {
        if let doc = viewModel.canvasDocument {
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        // 畫布底層框架
                        Color.white
                            .frame(width: doc.dimensions.width, height: doc.dimensions.height)
                            .shadow(radius: 8)
                            
                        // 渲染各圖層
                        ForEach(doc.layers) { layer in
                            renderLayer(layer, docDimensions: doc.dimensions)
                        }

                        // 渲染導引線
                        ForEach(activeGuides) { guide in
                            if guide.orientation == .vertical {
                                Rectangle()
                                    .fill(Color.orange)
                                    .frame(width: 1, height: doc.dimensions.height)
                                    .position(x: guide.position, y: doc.dimensions.height / 2)
                            } else {
                                Rectangle()
                                    .fill(Color.orange)
                                    .frame(width: doc.dimensions.width, height: 1)
                                    .position(x: doc.dimensions.width / 2, y: guide.position)
                            }
                        }
                        
                        // Regional Selection Overlay
                        if isSelectingRegion, let start = selectionStart, let current = selectionCurrent {
                            let rect = CGRect(
                                x: min(start.x, current.x),
                                y: min(start.y, current.y),
                                width: abs(current.x - start.x),
                                height: abs(current.y - start.y)
                            )
                            Rectangle()
                                .fill(Color.blue.opacity(0.3))
                                .border(Color.blue, width: 2)
                                .frame(width: rect.width, height: rect.height)
                                .position(x: rect.midX, y: rect.midY)
                        }
                    }
                    .padding(40)
                    .scaleEffect(canvasZoom + currentZoom)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { value in
                                currentZoom = value - 1
                            }
                            .onEnded { value in
                                canvasZoom = max(0.2, min(5.0, canvasZoom + currentZoom))
                                currentZoom = 0
                            }
                    )
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                if isSelectingRegion {
                                    if selectionStart == nil {
                                        selectionStart = value.location
                                    }
                                    selectionCurrent = value.location
                                }
                            }
                            .onEnded { value in
                                if isSelectingRegion {
                                    if let start = selectionStart {
                                        let end = value.location
                                        let rect = CGRect(
                                            x: min(start.x, end.x),
                                            y: min(start.y, end.y),
                                            width: abs(end.x - start.x),
                                            height: abs(end.y - start.y)
                                        )
                                        
                                        // 座標轉換：Canvas 是 top-left, C++ API也是 top-left origin?
                                        // 測試後若有偏移再調整
                                        Task {
                                            await viewModel.performRegionalOCR(inRect: rect)
                                        }
                                    }
                                    selectionStart = nil
                                    selectionCurrent = nil
                                    isSelectingRegion = false
                                }
                            }
                    )
                }
                .background(Color(platformColor: PlatformColor.themeUnderPageBackground))
            }
        } else {
            emptyStateView
        }
    }
    
    @ViewBuilder
    private func renderLayer(_ layer: CanvasLayer, docDimensions: CGSize) -> some View {
        let rect = layer.boundingBox.rect
        // 翻轉 Y 軸以適應 Core 座標與 standard top-left 渲染
        let renderY = docDimensions.height - rect.origin.y - rect.height
        
        let isDragging = draggingLayerId == layer.id
        let currentX = rect.origin.x + (isDragging ? dragOffset.width : 0)
        let currentY = renderY + (isDragging ? dragOffset.height : 0)

        Group {
            switch layer.type {
            case .image:
                if let nsImg = layer.image {
                    Image(platformImage: nsImg)
                        .resizable()
                } else {
                    // Placeholder for images (e.g. background layers without loaded texture)
                    Rectangle()
                        .fill(Color.gray.opacity(0.1))
                        .overlay(
                            VStack(spacing: 8) {
                                Image(systemName: "photo")
                                    .font(.title)
                                Text(layer.name)
                                    .font(.caption)
                            }
                            .foregroundColor(.gray)
                        )
                }
                
            case .vector:
                Rectangle()
                    .fill(Color.blue.opacity(0.15))
                    .overlay(
                        VStack(spacing: 4) {
                            Image(systemName: "triangle.fill")
                                .font(.headline)
                            Text("獨立向量元件")
                                .font(.system(size: 10))
                        }
                        .foregroundColor(.blue)
                    )
                
            case .text:
                Text(layer.text)
                    .font(Font(layer.fontEstimate.nsFont))
                    .foregroundColor(Color(layer.fontEstimate.color))
                    .frame(width: rect.width, height: rect.height, alignment: .topLeading)
            }
        }
        .frame(width: rect.width, height: rect.height)
        .overlay(
            Rectangle()
                .stroke(viewModel.selectedLayerId == layer.id ? Color.accentColor : (hoveredLayerId == layer.id ? Color.accentColor.opacity(0.4) : Color.clear), lineWidth: 2)
        )
        .position(x: currentX + rect.width / 2, y: currentY + rect.height / 2)
        .contentShape(Rectangle())
        .onHover { isHovered in
            hoveredLayerId = isHovered ? layer.id : nil
        }
        .onTapGesture {
            viewModel.selectedLayerId = layer.id
        }
        .gesture(
            DragGesture()
                .onChanged { value in
                    handleDragChange(for: layer, translation: value.translation, docDimensions: docDimensions)
                }
                .onEnded { value in
                    handleDragEnd(for: layer, docDimensions: docDimensions)
                }
        )
    }
    
    // MARK: - Snapping Logic

    private func handleDragChange(for layer: CanvasLayer, translation: CGSize, docDimensions: CGSize) {
        if draggingLayerId == nil {
            draggingLayerId = layer.id
        }

        var newOffset = translation
        var guides: [GuideLine] = []
        let threshold: CGFloat = 8.0 // Snapping distance threshold
        
        guard let doc = viewModel.canvasDocument else { return }
        
        let rect = layer.boundingBox.rect
        let renderY = docDimensions.height - rect.origin.y - rect.height
        
        let rawX = rect.origin.x + translation.width
        let rawY = renderY + translation.height
        
        let myLeft = rawX
        let myHCenter = rawX + rect.width / 2
        let myRight = rawX + rect.width
        let myTop = rawY
        let myVCenter = rawY + rect.height / 2
        let myBottom = rawY + rect.height
        
        var snappedX = rawX
        var snappedY = rawY
        var didSnapX = false
        var didSnapY = false

        // Check against other layers
        for other in doc.layers where other.id != layer.id {
            let oRect = other.boundingBox.rect
            let oRenderY = docDimensions.height - oRect.origin.y - oRect.height
            
            let oLeft = oRect.origin.x
            let oHCenter = oRect.origin.x + oRect.width / 2
            let oRight = oRect.origin.x + oRect.width
            
            let oTop = oRenderY
            let oVCenter = oRenderY + oRect.height / 2
            let oBottom = oRenderY + oRect.height
            
            // X-axis snapping
            if !didSnapX {
                if abs(myLeft - oLeft) < threshold { snappedX = oLeft; didSnapX = true; guides.append(GuideLine(orientation: .vertical, position: oLeft)) }
                else if abs(myRight - oRight) < threshold { snappedX = oRight - rect.width; didSnapX = true; guides.append(GuideLine(orientation: .vertical, position: oRight)) }
                else if abs(myHCenter - oHCenter) < threshold { snappedX = oHCenter - rect.width / 2; didSnapX = true; guides.append(GuideLine(orientation: .vertical, position: oHCenter)) }
            }
            
            // Y-axis snapping
            if !didSnapY {
                if abs(myTop - oTop) < threshold { snappedY = oTop; didSnapY = true; guides.append(GuideLine(orientation: .horizontal, position: oTop)) }
                else if abs(myBottom - oBottom) < threshold { snappedY = oBottom - rect.height; didSnapY = true; guides.append(GuideLine(orientation: .horizontal, position: oBottom)) }
                else if abs(myVCenter - oVCenter) < threshold { snappedY = oVCenter - rect.height / 2; didSnapY = true; guides.append(GuideLine(orientation: .horizontal, position: oVCenter)) }
            }
        }
        
        newOffset.width = snappedX - rect.origin.x
        newOffset.height = snappedY - renderY
        
        self.dragOffset = newOffset
        self.activeGuides = guides
    }
    
    private func handleDragEnd(for layer: CanvasLayer, docDimensions: CGSize) {
        let rect = layer.boundingBox.rect
        let finalX = rect.origin.x + dragOffset.width
        let finalRenderY = (docDimensions.height - rect.origin.y - rect.height) + dragOffset.height
        
        // Convert back to core coordinates
        let newCoreY = docDimensions.height - finalRenderY - rect.height
        let newRect = CGRect(x: finalX, y: newCoreY, width: rect.width, height: rect.height)
        
        viewModel.updateLayerRect(layerId: layer.id, newRect: newRect)
        
        self.draggingLayerId = nil
        self.dragOffset = .zero
        self.activeGuides = []
    }
    
    @ViewBuilder
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.text.viewfinder")
                .font(.system(size: 64))
                .foregroundColor(.secondary.opacity(0.5))

            Text("拖放影像、PDF 或 PPTX 簡報到此處")
                .font(.title2)
                .foregroundColor(.secondary)

            Text("系統將自動分離圖層、提取內置圖片與文字元素")
                .font(.callout)
                .foregroundColor(.gray)

            Button {
                isFileImporterPresented = true
            } label: {
                Label("開啟新檔案", systemImage: "photo")
                    .font(.body)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            
            #if os(iOS)
            Button {
                isScannerPresented = true
            } label: {
                Label("掃描文件", systemImage: "camera.viewfinder")
                    .font(.body)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 4)
            #endif
            
            Button {
                viewModel.loadSampleDocument()
            } label: {
                Label("載入體驗簡報範本", systemImage: "doc.richtext")
                    .font(.body)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(platformColor: PlatformColor.themeControlBackground))
        .onDrop(of: supportedFileTypes, isTargeted: nil) { providers in
            handleDrop(providers)
        }
    }
}

// MARK: - 右側屬性控制區 (Inspector)

extension ContentView {
    @ViewBuilder
    private var inspectorArea: some View {
        VStack(spacing: 0) {
            Text("Text Formatting Panel")
                .font(.title2)
                .bold()
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(platformColor: PlatformColor.themeControlBackground).opacity(0.5))
            
            Divider()
            
            if let id = viewModel.selectedLayerId,
               let doc = viewModel.canvasDocument,
               let layer = doc.layers.first(where: { $0.id == id }) {
                
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // 1. 元件基本資訊
                        VStack(alignment: .leading, spacing: 6) {
                            Text("類型: \(layer.type.rawValue.uppercased())")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Text("名稱: \(layer.name)")
                                .font(.subheadline)
                                .bold()
                            
                            let rect = layer.boundingBox.rect
                            Text("尺寸: \(Int(rect.width)) x \(Int(rect.height))")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        
                        Divider()
                        
                        // 2. 文字編輯區塊
                        if layer.type == .text {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Edit Content")
                                    .font(.subheadline)
                                    .bold()
                                
                                TextEditor(text: $viewModel.inspectorText)
                                    .font(.system(.body))
                                    .frame(height: 120)
                                    .padding(4)
                                    .background(Color(platformColor: PlatformColor.themeControlBackground))
                                    .cornerRadius(6)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                                    )
                                
                                Text("Paragraph Format")
                                    .font(.subheadline)
                                    .bold()
                                    .padding(.top, 10)
                                
                                // 字級
                                HStack {
                                    Text("Size:")
                                    Slider(value: $viewModel.inspectorFontSize, in: 8...120, step: 1)
                                    Text("\(Int(viewModel.inspectorFontSize))px")
                                        .frame(width: 45, alignment: .trailing)
                                }
                                
                                // 字型
                                HStack {
                                    Text("Font:")
                                    Picker("", selection: $viewModel.inspectorFontName) {
                                        ForEach(viewModel.availableFonts, id: \.self) { fontName in
                                            Text(fontName).tag(fontName)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                }
                                
                                // 粗體與斜體按鈕列
                                HStack(spacing: 12) {
                                    Toggle(isOn: $viewModel.inspectorIsBold) {
                                        Text("Bold")
                                            .fontWeight(.bold)
                                            .frame(maxWidth: .infinity)
                                    }
                                    .toggleStyle(.button)
                                    
                                    // 預留斜體（目前 viewModel 未實作斜體，可用視覺佔位）
                                    Button(action: {}) {
                                        Text("Italic")
                                            .italic()
                                            .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(.bordered)
                                }
                                
                                Text("Color Presets:")
                                    .font(.subheadline)
                                    .padding(.top, 10)
                                
                                // 顏色圓點預設列
                                HStack(spacing: 12) {
                                    let colors: [Color] = [.white, .red, .green, .blue, .yellow, .purple]
                                    ForEach(0..<colors.count, id: \.self) { i in
                                        Circle()
                                            .fill(colors[i])
                                            .frame(width: 24, height: 24)
                                            .overlay(Circle().stroke(Color.gray, lineWidth: 1))
                                            .onTapGesture {
                                                viewModel.inspectorFontColor = colors[i]
                                            }
                                    }
                                }
                                
                                Text("AI Operations (Local LLM)")
                                    .font(.subheadline)
                                    .bold()
                                    .padding(.top, 10)
                                    
                                HStack {
                                    Button {
                                        Task { await viewModel.fixSelectedLayerText() }
                                    } label: {
                                        if viewModel.isProcessing {
                                            ProgressView().controlSize(.small)
                                        } else {
                                            Text("Fix Text")
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .buttonStyle(.bordered)
                                    .disabled(viewModel.isProcessing || viewModel.isTranslating)
                                    
                                    Button {
                                        Task { await viewModel.extractEntitiesFromSelectedLayer() }
                                    } label: {
                                        if viewModel.isProcessing {
                                            ProgressView().controlSize(.small)
                                        } else {
                                            Text("Extract Entities")
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .buttonStyle(.bordered)
                                    .disabled(viewModel.isProcessing || viewModel.isTranslating)
                                }
                                
                                Button {
                                    Task { await viewModel.translateSelectedLayer() }
                                } label: {
                                    if viewModel.isTranslating {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Text("Translate to ZH")
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .buttonStyle(.bordered)
                                .disabled(viewModel.isTranslating || viewModel.isProcessing)
                                
                                Text("Operations")
                                    .font(.subheadline)
                                    .bold()
                                    .padding(.top, 10)
                                    
                                HStack {
                                    Toggle(isOn: $isSelectingRegion) {
                                        Text("Regional Re-OCR")
                                            .frame(maxWidth: .infinity)
                                    }
                                    .toggleStyle(.button)
                                    .buttonStyle(.bordered)
                                    
                                    Button {
                                        viewModel.deleteSelectedLayer()
                                    } label: {
                                        Text("Remove Text")
                                            .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }
                        
                        if layer.type == .image || layer.type == .vector {
                            Text("Operations")
                                .font(.subheadline)
                                .bold()
                                .padding(.top, 10)
                            
                            Button {
                                isImageReplacerPresented = true
                            } label: {
                                Label("替換圖片/圖標元件", systemImage: "arrow.triangle.2.circlepath")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            
                            Button {
                                viewModel.deleteSelectedLayer()
                            } label: {
                                Label("Remove Region", systemImage: "trash")
                                    .frame(maxWidth: .infinity)
                                    .foregroundColor(.white)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.red)
                            .controlSize(.large)
                        }
                        
                        Text("Tip: If AI missed a word, click-and-drag directly on the image to draw a manual text box!")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .padding(.top, 10)
                    }
                    .padding()
                }
            } else if let doc = viewModel.canvasDocument {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // 1. 文件基本資訊
                        VStack(alignment: .leading, spacing: 6) {
                            Text("文件屬性")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Text("名稱: \(doc.name)")
                                .font(.subheadline)
                                .bold()
                            Text("畫布尺寸: \(Int(doc.dimensions.width)) x \(Int(doc.dimensions.height))")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        
                        Divider()
                        
                        // 2. 全域字型替換選項
                        VStack(alignment: .leading, spacing: 10) {
                            Text("一鍵字型替換")
                                .font(.subheadline)
                                .bold()
                            
                            Text("可將全檔所有文字區塊一次性替換為選定的通用字型。")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            
                            HStack {
                                Text("目標字型:")
                                Picker("", selection: $viewModel.globalFontName) {
                                    ForEach(viewModel.availableFonts, id: \.self) { fontName in
                                        Text(fontName).tag(fontName)
                                    }
                                }
                                .pickerStyle(.menu)
                                .labelsHidden()
                            }
                            
                            Button {
                                viewModel.replaceAllTextFonts(with: viewModel.globalFontName)
                            } label: {
                                Label("一鍵替換全檔字型", systemImage: "textformat")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                        }
                        
                        Spacer()
                    }
                    .padding()
                }
            } else {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "hand.tap")
                        .font(.largeTitle)
                        .foregroundColor(.secondary.opacity(0.5))
                    Text("請點擊選取畫布上的元件進行編輯")
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                    Spacer()
                }
            }
        }
    }
}

// MARK: - 工具列

extension ContentView {
    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            // 開啟新檔案
            Button {
                isFileImporterPresented = true
            } label: {
                Label("開啟新檔案", systemImage: "photo.badge.plus")
            }
            .help("開啟檔案、PDF或簡報 (⌘O)")
            .keyboardShortcut("o", modifiers: .command)
            
            // 關閉檔案
            Button {
                viewModel.closeDocument()
            } label: {
                Label("關閉檔案", systemImage: "xmark.circle")
            }
            .help("關閉目前檔案 (⌘W)")
            .keyboardShortcut("w", modifiers: .command)
            .disabled(viewModel.canvasDocument == nil)
            
            #if os(macOS)
            // 匯出選單
            Menu {
                Button("匯出為 CSV") {
                    let panel = NSSavePanel()
                    panel.allowedContentTypes = [.commaSeparatedText]
                    panel.nameFieldStringValue = "ExportedData.csv"
                    if panel.runModal() == .OK, let url = panel.url {
                        viewModel.exportToCSV(url: url)
                    }
                }
                Button("匯出為 Markdown") {
                    if let md = viewModel.exportToMarkdown() {
                        let panel = NSSavePanel()
                        panel.allowedContentTypes = [.plainText]
                        panel.nameFieldStringValue = "ExportedData.md"
                        if panel.runModal() == .OK, let url = panel.url {
                            try? md.write(to: url, atomically: true, encoding: .utf8)
                        }
                    }
                }
                Button("匯出為可搜尋 PDF") {
                    let panel = NSSavePanel()
                    panel.allowedContentTypes = [.pdf]
                    panel.nameFieldStringValue = "ExportedDocument.pdf"
                    if panel.runModal() == .OK, let url = panel.url {
                        viewModel.exportToPDF(url: url)
                    }
                }
                Button("匯出為專案檔 (.ocrproj)") {
                    let panel = NSSavePanel()
                    // Just use json extension for simplicity if custom type is not defined
                    panel.allowedContentTypes = [.json]
                    panel.nameFieldStringValue = "Project.ocrproj"
                    if panel.runModal() == .OK, let url = panel.url {
                        viewModel.exportToProject(url: url)
                    }
                }
            } label: {
                Label("匯出", systemImage: "square.and.arrow.up")
            }
            .help("匯出檔案")
            #else
            // iOS 匯出選單 (Share Sheet)
            Menu {
                Button("匯出為文字") {
                    viewModel.exportText() // which puts it in clipboard
                }
            } label: {
                Label("匯出", systemImage: "square.and.arrow.up")
            }
            #endif

            #if os(iOS)
            // 掃描文件
            Button {
                isScannerPresented = true
            } label: {
                Label("掃描", systemImage: "camera")
            }
            #endif

            // 新增文字元件
            Button {
                viewModel.insertTextLayer()
            } label: {
                Label("新增文字", systemImage: "text.cursor")
            }
            .help("新增文字區塊 (⌘T)")
            .keyboardShortcut("t", modifiers: .command)
            
            // 刪除選取元件
            Button {
                viewModel.deleteSelectedLayer()
            } label: {
                Label("刪除元件", systemImage: "trash")
            }
            .disabled(viewModel.selectedLayerId == nil)
            .help("刪除選取的元件 (⌫)")
            .keyboardShortcut(.delete, modifiers: [])

            Divider()
            
            // 語系選擇
            Picker("辨識語系", selection: $viewModel.recognizedLanguage) {
                Text("繁英混合").tag("ch_tra,eng")
                Text("簡英混合").tag("ch_sim,eng")
                Text("僅英文").tag("eng")
                Text("日文").tag("japan")
                Text("韓文").tag("korean")
            }
            .pickerStyle(MenuPickerStyle())
            .frame(width: 120)
            .help("選擇 OCR 優先辨識語言")
            
            // 翻譯與校正
            Menu {
                Button("LLM 智慧翻譯 (本機)") {
                    Task { await viewModel.translateDocument() }
                }
                Button("自訂字典校正 (Rule-based)") {
                    viewModel.applyRuleBasedCorrection()
                }
            } label: {
                Label("翻譯校正", systemImage: "textformat.abc.dottedunderline")
            }
            .help("翻譯與自動校正文字")

            Menu {
                Toggle("OCR後強制套用電腦字型", isOn: $viewModel.forceComputerFontAfterOCR)
                
                Picker("主要字型 (中日韓)", selection: $viewModel.primaryOCRFont) {
                    ForEach(["PingFang TC", "Heiti TC", "Hiragino Sans GB", "Noto Sans CJK TC"], id: \.self) { font in
                        Text(font).tag(font)
                    }
                }
                
                Picker("次要字型 (英數)", selection: $viewModel.secondaryOCRFont) {
                    ForEach(["Century Gothic", "Helvetica", "Arial", "Times New Roman"], id: \.self) { font in
                        Text(font).tag(font)
                    }
                }
                
                Divider()
                
                Button("🔤 套用預設字體至全部") {
                    viewModel.applyDefaultFontToAll()
                }
            } label: {
                Label("字體設定", systemImage: "textformat")
            }
            .help("設定文字方塊的預設字體")

            Divider()

            // 還原
            Button {
                viewModel.undo()
            } label: {
                Label("還原", systemImage: "arrow.uturn.backward")
            }
            .disabled(!viewModel.canUndo)
            .help("還原 (⌘Z)")
            .keyboardShortcut("z", modifiers: .command)

            // 重做
            Button {
                viewModel.redo()
            } label: {
                Label("重做", systemImage: "arrow.uturn.forward")
            }
            .disabled(!viewModel.canRedo)
            .help("重做 (⇧⌘Z)")
            .keyboardShortcut("z", modifiers: [.command, .shift])
            
            Divider()
            
            // Zoom Controls
            HStack(spacing: 8) {
                Text("Zoom:")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Button(action: { canvasZoom = max(0.2, canvasZoom - 0.2) }) {
                    Image(systemName: "minus")
                }
                .buttonStyle(.plain)
                
                Text("\(Int(canvasZoom * 100))%")
                    .font(.caption)
                    .frame(width: 40)
                
                Button(action: { canvasZoom = min(5.0, canvasZoom + 0.2) }) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                
                Slider(value: $canvasZoom, in: 0.2...5.0)
                    .frame(width: 100)
            }
            .padding(.horizontal, 8)
            
            Divider()
            
            if viewModel.isUsingLightweightModel {
                Button {
                    viewModel.downloadModels()
                } label: {
                    Label("升級高精度模型", systemImage: "arrow.down.app")
                }
                .help("目前使用內建輕量模型，點此下載高精度模型")
                
                Divider()
            }
            
            HStack {
                Text("Engine:")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text("System OCR")
                    .font(.caption)
                    .bold()
            }
        }
    }
}

// MARK: - 事件處理

extension ContentView {
    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let secured = url.startAccessingSecurityScopedResource()
            Task {
                await viewModel.scanImage(from: url)
                if secured {
                    url.stopAccessingSecurityScopedResource()
                }
            }
        case .failure(let error):
            viewModel.errorMessage = "檔案開啟失敗: \(error.localizedDescription)"
        }
    }
    
    private func handleImageReplaceImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let secured = url.startAccessingSecurityScopedResource()
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            #if os(macOS)
            guard let img = PlatformImage(contentsOf: url) else { return }
            #elseif os(iOS)
            guard let data = try? Data(contentsOf: url), let img = PlatformImage(data: data) else { return }
            #endif
            viewModel.replaceSelectedLayerImage(with: img)
        case .failure(let error):
            viewModel.errorMessage = "替換圖片讀取失敗: \(error.localizedDescription)"
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }

        for type in supportedFileTypes {
            if provider.hasItemConformingToTypeIdentifier(type.identifier) {
                provider.loadItem(forTypeIdentifier: type.identifier) { item, error in
                    DispatchQueue.main.async {
                        if let url = item as? URL {
                            let secured = url.startAccessingSecurityScopedResource()
                            Task {
                                await viewModel.scanImage(from: url)
                                if secured {
                                    url.stopAccessingSecurityScopedResource()
                                }
                            }
                        } else if let data = item as? Data, let image = PlatformImage(data: data) {
                            Task {
                                await viewModel.scanImage(image)
                            }
                        }
                    }
                }
                return true
            }
        }
        return false
    }
}

// MARK: - ListRowSelected Modifier

extension View {
    func listRowSelected(_ isSelected: Bool) -> some View {
        background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
            .cornerRadius(6)
    }
}
