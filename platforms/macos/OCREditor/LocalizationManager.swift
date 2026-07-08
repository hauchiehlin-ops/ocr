import Foundation
import SwiftUI

class LocalizationManager: ObservableObject {
    static let shared = LocalizationManager()
    
    @Published var currentLanguage: String = "zh-Hant" // Default to Traditional Chinese
    
    private init() {
        // Load saved language or default to system language
        let savedLang = UserDefaults.standard.string(forKey: "app_language")
        if let lang = savedLang {
            self.currentLanguage = lang
        } else {
            let sysLang = Locale.preferredLanguages.first ?? "zh-Hant"
            if sysLang.hasPrefix("en") {
                self.currentLanguage = "en"
            } else {
                self.currentLanguage = "zh-Hant"
            }
        }
    }
    
    func setLanguage(_ languageCode: String) {
        self.currentLanguage = languageCode
        UserDefaults.standard.set(languageCode, forKey: "app_language")
    }
    
    func localizedString(forKey key: String) -> String {
        guard let bundlePath = Bundle.main.path(forResource: currentLanguage, ofType: "lproj"),
              let bundle = Bundle(path: bundlePath) else {
            return NSLocalizedString(key, comment: "")
        }
        return bundle.localizedString(forKey: key, value: nil, table: nil)
    }
}

// SwiftUI Helper
struct LocalizedText: View {
    let key: String
    @ObservedObject var localizationManager = LocalizationManager.shared
    
    init(_ key: String) {
        self.key = key
    }
    
    var body: some View {
        Text(localizationManager.localizedString(forKey: key))
    }
}

// Extension to get localized string easily
extension String {
    var localized: String {
        return LocalizationManager.shared.localizedString(forKey: self)
    }
}
