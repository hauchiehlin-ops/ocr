//
//  OCREditorApp.swift
//  OCREditor
//
//  應用程式入口 — 定義視窗配置與選單指令
//

import SwiftUI

@main
struct OCREditorApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1200, height: 800)
        .commands {
            // 替換預設的「新增」選單項目
            CommandGroup(replacing: .newItem) {
                Button("開啟圖片…") {
                    // 透過 NotificationCenter 通知 ContentView 開啟檔案選擇器
                    NotificationCenter.default.post(
                        name: .openImageFile,
                        object: nil
                    )
                }
                .keyboardShortcut("o", modifiers: .command)
            }

            // 編輯選單擴充
            CommandGroup(after: .undoRedo) {
                Divider()

                Button("全選文字") {
                    NotificationCenter.default.post(
                        name: .selectAllWords,
                        object: nil
                    )
                }
                .keyboardShortcut("a", modifiers: .command)

                Button("清除選取") {
                    NotificationCenter.default.post(
                        name: .clearSelection,
                        object: nil
                    )
                }
                .keyboardShortcut("d", modifiers: .command)
            }

            // 工具選單
            CommandMenu("工具") {
                Button("匯出辨識文字") {
                    NotificationCenter.default.post(
                        name: .exportText,
                        object: nil
                    )
                }
                .keyboardShortcut("e", modifiers: [.command, .shift])

                Divider()

                Button("刪除選取文字") {
                    NotificationCenter.default.post(
                        name: .deleteSelectedText,
                        object: nil
                    )
                }
                .keyboardShortcut(.delete, modifiers: .command)
            }
        }
    }
}

// MARK: - 自訂通知名稱

extension Notification.Name {
    /// 開啟影像檔案
    static let openImageFile     = Notification.Name("com.ocr-editor.openImageFile")
    /// 全選文字
    static let selectAllWords    = Notification.Name("com.ocr-editor.selectAllWords")
    /// 清除選取
    static let clearSelection    = Notification.Name("com.ocr-editor.clearSelection")
    /// 匯出文字
    static let exportText        = Notification.Name("com.ocr-editor.exportText")
    /// 刪除選取文字
    static let deleteSelectedText = Notification.Name("com.ocr-editor.deleteSelectedText")
}
