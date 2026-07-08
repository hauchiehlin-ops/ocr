//
//  OCREditorApp.swift
//  OCREditor
//
//  應用程式入口 — 定義視窗配置與選單指令
//

import SwiftUI

@main
struct OCREditorApp: App {
    init() {
        // 初始化設定同步管理員
        _ = SettingsSyncManager.shared
        
        // 初始化歷史紀錄資料庫
        if let docsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            let dbPath = docsDir.appendingPathComponent("history.db").path
            OCREngineBridge.initializeHistory(withFilePath: dbPath)
        }
    }
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
        #if os(macOS)
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
        #endif
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
//
//  SettingsSyncManager.swift
//  OCREditor
//
//  同步 C++ SettingsManager 與 iCloud NSUbiquitousKeyValueStore 的管理類別
//

import Foundation

class SettingsSyncManager {
    static let shared = SettingsSyncManager()
    
    private let ubiquitousStore = NSUbiquitousKeyValueStore.default
    
    private init() {
        // 設定設定檔的路徑
        let fileManager = FileManager.default
        if let docURL = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first {
            let settingsPath = docURL.appendingPathComponent("settings.json").path
            OCREngineBridge.initializeSettings(withFilePath: settingsPath)
            print("[SettingsSyncManager] ⚙️ 初始化 C++ SettingsManager: \(settingsPath)")
        }
        
        // 註冊 iCloud 同步通知
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(storeDidChange(_:)),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: ubiquitousStore
        )
        
        // 初次同步（從 iCloud 抓取）
        ubiquitousStore.synchronize()
        syncToLocal()
    }
    
    /// 將本機（C++ SettingsManager）的變更上傳到 iCloud
    func syncToCloud() {
        let jsonStr = OCREngineBridge.getAllSettingsJson()
        if let data = jsonStr.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
            
            for (key, value) in dict {
                ubiquitousStore.set(value, forKey: key)
            }
            ubiquitousStore.synchronize()
            print("[SettingsSyncManager] ☁️ 已同步設定至 iCloud")
        }
    }
    
    /// 將 iCloud 的設定下載到本機（C++ SettingsManager）
    func syncToLocal() {
        let dict = ubiquitousStore.dictionaryRepresentation
        if !dict.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
           let jsonStr = String(data: data, encoding: .utf8) {
            
            if OCREngineBridge.syncSettings(fromJson: jsonStr) {
                print("[SettingsSyncManager] 📥 已從 iCloud 同步設定至本機")
                // 發送通知更新 UI
                NotificationCenter.default.post(name: .settingsDidChange, object: nil)
            }
        }
    }
    
    @objc private func storeDidChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo else { return }
        guard let reasonForChange = userInfo[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int else { return }
        
        if reasonForChange == NSUbiquitousKeyValueStoreServerChange || reasonForChange == NSUbiquitousKeyValueStoreInitialSyncChange {
            print("[SettingsSyncManager] ☁️ 偵測到 iCloud 設定變更，正在同步到本機...")
            syncToLocal()
        }
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

extension Notification.Name {
    static let settingsDidChange = Notification.Name("com.ocr-editor.settingsDidChange")
}
