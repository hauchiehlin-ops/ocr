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
