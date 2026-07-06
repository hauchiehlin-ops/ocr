//
//  ContentView.swift
//  OCREditor
//
//  主介面 — NavigationSplitView 配置：左側圖層面板 + 中間多圖層畫布 + 右側屬性控制區
//

import SwiftUI
import UniformTypeIdentifiers
import PDFKit

// MARK: - ContentView

struct ContentView: View {
    @StateObject private var viewModel = OCRViewModel()
    @State private var isFileImporterPresented = false
    @State private var isImageReplacerPresented = false
    @State private var hoveredLayerId: UUID? = nil
    @State private var sidebarWidth: CGFloat = 300
    @State private var inspectorWidth: CGFloat = 320

    var body: some View {
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
                    .background(Color(nsColor: .windowBackgroundColor))
            }
        }
        .toolbar {
            toolbarContent
        }
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
        .frame(minWidth: 1100, minHeight: 750)
        .alert("錯誤", isPresented: showingError) {
            Button("確定", role: .cancel) {
                viewModel.errorMessage = nil
            }
        } message: {
            Text(viewModel.errorMessage ?? "發生未知錯誤")
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
                Section("處理狀態") {
                    statusView
                }
                
                if let doc = viewModel.canvasDocument {
                    Section("圖層元件清單") {
                        ForEach(doc.layers) { layer in
                            HStack {
                                Image(systemName: iconForLayer(layer.type))
                                    .foregroundColor(.secondary)
                                    .frame(width: 20)
                                
                                Text(layer.name)
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
                    }
                    .padding(40)
                }
                .background(Color(nsColor: .underPageBackgroundColor))
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
        
        Group {
            switch layer.type {
            case .image:
                if let nsImg = layer.image {
                    Image(nsImage: nsImg)
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
        .position(x: rect.origin.x + rect.width / 2, y: renderY + rect.height / 2)
        .contentShape(Rectangle())
        .onHover { isHovered in
            hoveredLayerId = isHovered ? layer.id : nil
        }
        .onTapGesture {
            viewModel.selectedLayerId = layer.id
        }
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
        .background(Color(nsColor: .controlBackgroundColor))
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
            Text("元件屬性控制")
                .font(.headline)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            
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
                                Text("編輯段落內容")
                                    .font(.subheadline)
                                    .bold()
                                
                                TextEditor(text: $viewModel.inspectorText)
                                    .font(.system(.body))
                                    .frame(height: 120)
                                    .padding(4)
                                    .background(Color(nsColor: .controlBackgroundColor))
                                    .cornerRadius(6)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                                    )
                                
                                Text("調整文字樣式")
                                    .font(.subheadline)
                                    .bold()
                                    .padding(.top, 10)
                                
                                // 字級
                                HStack {
                                    Text("大小:")
                                    Slider(value: $viewModel.inspectorFontSize, in: 8...120, step: 1)
                                    Text("\(Int(viewModel.inspectorFontSize))px")
                                        .frame(width: 45, alignment: .trailing)
                                }
                                
                                // 粗體與顏色
                                Toggle("粗體格式 (Bold)", isOn: $viewModel.inspectorIsBold)
                                    .toggleStyle(.checkbox)
                                
                                ColorPicker("文字顏色:", selection: $viewModel.inspectorFontColor)

                                // 字型與一次性替換選項
                                HStack {
                                    Text("字型:")
                                    Picker("", selection: $viewModel.inspectorFontName) {
                                        ForEach(viewModel.availableFonts, id: \.self) { fontName in
                                            Text(fontName).tag(fontName)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                }
                                
                                Button {
                                    viewModel.replaceAllTextFonts(with: viewModel.inspectorFontName)
                                } label: {
                                    Label("套用到全檔文字區塊", systemImage: "textformat")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.regular)
                            }
                        }
                        
                        // 3. 元件替換與刪除動作
                        VStack(spacing: 12) {
                            if layer.type == .text {
                                Button {
                                    Task {
                                        await viewModel.translateSelectedLayer()
                                    }
                                } label: {
                                    HStack {
                                        if viewModel.isTranslating {
                                            ProgressView()
                                                .controlSize(.small)
                                                .padding(.trailing, 4)
                                        } else {
                                            Image(systemName: "translate")
                                        }
                                        Text("原地離線翻譯")
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.large)
                                .disabled(viewModel.isTranslating)
                            }

                            if layer.type == .image || layer.type == .vector {
                                Button {
                                    isImageReplacerPresented = true
                                } label: {
                                    Label("替換圖片/圖標元件", systemImage: "arrow.triangle.2.circlepath")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.large)
                            }
                            
                            Button(role: .destructive) {
                                viewModel.deleteSelectedLayer()
                            } label: {
                                Label("刪除此元件", systemImage: "trash")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                        }
                        .padding(.top, 20)
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
        }
    }
}

// MARK: - 事件處理

extension ContentView {
    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            Task {
                await viewModel.scanImage(from: url)
            }
        case .failure(let error):
            viewModel.errorMessage = "檔案開啟失敗: \(error.localizedDescription)"
        }
    }
    
    private func handleImageReplaceImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first, let img = NSImage(contentsOf: url) else { return }
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
                            Task {
                                await viewModel.scanImage(from: url)
                            }
                        } else if let data = item as? Data, let image = NSImage(data: data) {
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
