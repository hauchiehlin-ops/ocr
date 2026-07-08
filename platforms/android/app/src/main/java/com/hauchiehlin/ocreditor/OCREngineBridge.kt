package com.hauchiehlin.ocreditor

import android.graphics.Bitmap

object OCREngineBridge {
    init {
        System.loadLibrary("ocreditor")
    }

    /**
     * 初始化 OCR 引擎
     * @param modelPath 模型檔案所在的目錄路徑
     * @param configJson 動態設定 JSON (如語系)
     * @return 成功回傳 true，失敗回傳 false
     */
    external fun initEngine(modelPath: String, configJson: String? = null): Boolean

    /**
     * 辨識圖片中的文字
     * @param bitmap 圖片 (必須是 ARGB_8888 格式)
     * @param bitmap 圖片 (必須是 ARGB_8888 格式)
     * @return 包含辨識結果的 JSON 字串
     */
    external fun recognizeText(bitmap: Bitmap): String

    /**
     * 辨識圖片中的特定區域文字 (Regional Re-OCR)
     */
    external fun recognizeRegion(bitmap: Bitmap, x: Int, y: Int, w: Int, h: Int): String
    
    // ============================================================
    // Inpainting & Image Processing API
    // ============================================================
    
    /**
     * 從圖片中移除文字 (Inpainting)
     * @param bitmap 圖片 (必須是 ARGB_8888 格式)
     * @param x 區域左上角 X
     * @param y 區域左上角 Y
     * @param w 區域寬度
     * @param h 區域高度
     * @return 處理後的新 Bitmap，如果失敗則回傳 null
     */
    external fun removeText(bitmap: Bitmap, x: Int, y: Int, w: Int, h: Int): Bitmap?

    /**
     * 替換圖片中的文字
     * @param bitmap 圖片 (必須是 ARGB_8888 格式)
     * @param x 區域左上角 X
     * @param y 區域左上角 Y
     * @param w 區域寬度
     * @param h 區域高度
     * @param newText 新的文字內容
     * @param fontConfigJson 字體設定 JSON (可選)
     * @return 處理後的新 Bitmap，如果失敗則回傳 null
     */
    external fun replaceText(bitmap: Bitmap, x: Int, y: Int, w: Int, h: Int, newText: String, fontConfigJson: String?): Bitmap?

    // ============================================================
    // Export & Formatting API
    // ============================================================
    external fun exportMarkdownFromJson(jsonString: String): String
    external fun exportCSVFromJson(jsonString: String): String?
    external fun exportPDF(imagePath: String, jsonState: String, outputPath: String): Boolean

    // ============================================================
    // History API
    // ============================================================
    external fun initHistory(dbPath: String)
    external fun saveHistoryDocument(docId: String, jsonData: String, title: String, previewImagePath: String?)
    external fun getAllHistoryJson(): String

    // ============================================================
    // Settings & Sync API
    // ============================================================
    external fun initSettings(filePath: String)
    external fun syncSettingsFromJson(jsonString: String): Boolean
    external fun getAllSettingsJson(): String
    
    external fun setStringSetting(key: String, value: String)
    external fun getStringSetting(key: String, defaultValue: String): String
    
    external fun setIntSetting(key: String, value: Int)
    external fun getIntSetting(key: String, defaultValue: Int): Int

    // ============================================================
    // LLM API
    // ============================================================
    external fun loadLLMModel(modelPath: String): Boolean
    external fun fixTextWithLLM(text: String): String?
    external fun translateWithLLM(text: String, targetLang: String): String?
    external fun extractEntitiesWithLLM(text: String): String?

    // ============================================================
    // Project Archive API (.ocrproj)
    // ============================================================
    external fun saveProjectArchive(imagePath: String, jsonState: String, outputPath: String): Boolean
    external fun loadProjectArchive(inputPath: String): Array<String>? // Returns [imagePath, jsonState]
}
