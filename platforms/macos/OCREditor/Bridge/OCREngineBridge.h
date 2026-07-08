//
//  OCREngineBridge.h
//  OCREditor
//
//  macOS 平台橋接層 — 將 C++ OCR Core API 封裝為 Objective-C 介面供 Swift 呼叫
//

#import <Foundation/Foundation.h>
#if TARGET_OS_OSX
#import <AppKit/AppKit.h>
#define PlatformImage NSImage
#define PlatformColor NSColor
#else
#import <UIKit/UIKit.h>
#define PlatformImage UIImage
#define PlatformColor UIColor
#endif

NS_ASSUME_NONNULL_BEGIN

#pragma mark - OCRBoundingBox

/// 文字區域的四角座標（順時針：左上→右上→右下→左下）
@interface OCRBoundingBox : NSObject

@property (nonatomic, assign) CGPoint topLeft;
@property (nonatomic, assign) CGPoint topRight;
@property (nonatomic, assign) CGPoint bottomRight;
@property (nonatomic, assign) CGPoint bottomLeft;

/// 以四角座標初始化
- (instancetype)initWithTopLeft:(CGPoint)topLeft
                       topRight:(CGPoint)topRight
                    bottomRight:(CGPoint)bottomRight
                     bottomLeft:(CGPoint)bottomLeft;

/// 取得包圍矩形（axis-aligned bounding rect）
@property (nonatomic, readonly) CGRect boundingRect;

/// 取得中心點
@property (nonatomic, readonly) CGPoint center;

@end

#pragma mark - OCRWord

/// 辨識出的單一文字詞彙
@interface OCRWord : NSObject

@property (nonatomic, copy)   NSString    *text;           ///< 詞彙文字
@property (nonatomic, assign) CGFloat      confidence;     ///< 信心度 (0.0–1.0)
@property (nonatomic, strong) OCRBoundingBox *boundingBox; ///< 位置
@property (nonatomic, assign) CGFloat      estimatedFontSize; ///< 推估字體大小 (px)
@property (nonatomic, strong, nullable) PlatformColor *estimatedColor;  ///< 推估文字顏色
@property (nonatomic, assign) BOOL         isBold;         ///< 是否粗體

- (instancetype)initWithText:(NSString *)text
                  confidence:(CGFloat)confidence
                 boundingBox:(OCRBoundingBox *)boundingBox
           estimatedFontSize:(CGFloat)fontSize
              estimatedColor:(nullable PlatformColor *)color
                      isBold:(BOOL)isBold;

@end

#pragma mark - OCRLine

/// 辨識出的文字行
@interface OCRLine : NSObject

@property (nonatomic, copy)   NSString    *text;           ///< 整行文字
@property (nonatomic, assign) CGFloat      confidence;     ///< 行信心度
@property (nonatomic, strong) OCRBoundingBox *boundingBox; ///< 行位置
@property (nonatomic, copy)   NSArray<OCRWord *> *words;   ///< 詞彙陣列

- (instancetype)initWithText:(NSString *)text
                  confidence:(CGFloat)confidence
                 boundingBox:(OCRBoundingBox *)boundingBox
                       words:(NSArray<OCRWord *> *)words;

@end

#pragma mark - OCRTextBlock

/// 辨識出的文字區塊（段落、表格、標題等）
@interface OCRTextBlock : NSObject

@property (nonatomic, copy)   NSString    *identifier;     ///< 區塊唯一識別碼
@property (nonatomic, copy)   NSString    *type;           ///< 類型: paragraph/table/header/caption/unknown
@property (nonatomic, assign) CGFloat      confidence;     ///< 區塊信心度
@property (nonatomic, strong) OCRBoundingBox *boundingBox; ///< 區塊位置
@property (nonatomic, copy)   NSArray<OCRLine *> *lines;   ///< 行陣列

- (instancetype)initWithIdentifier:(NSString *)identifier
                              type:(NSString *)type
                        confidence:(CGFloat)confidence
                       boundingBox:(OCRBoundingBox *)boundingBox
                             lines:(NSArray<OCRLine *> *)lines;

@end

#pragma mark - OCRResult

/// 完整的 OCR 辨識結果
@interface OCRResult : NSObject

@property (nonatomic, assign) CGSize imageDimensions;              ///< 原始影像尺寸
@property (nonatomic, copy)   NSArray<OCRTextBlock *> *textBlocks; ///< 文字區塊陣列

/// 全文（由所有行文字串接而成）
@property (nonatomic, readonly) NSString *fullText;

/// 原始 JSON 字串 (保留給 C++ 匯出或進階處理使用)
@property (nonatomic, copy) NSString *rawJson;

- (instancetype)initWithImageDimensions:(CGSize)dimensions
                             textBlocks:(NSArray<OCRTextBlock *> *)textBlocks
                                rawJson:(NSString *)rawJson;

@end

#pragma mark - OCREngineBridge

/// OCR 引擎橋接物件 — 包裝 C++ 核心引擎
@interface OCREngineBridge : NSObject

/// 引擎是否就緒
@property (nonatomic, readonly, getter=isReady) BOOL ready;

/// 以模型目錄路徑初始化引擎
/// @param modelDirectory 模型檔案所在目錄
/// @param language 語系提示，例如 "ch_tra,eng" 或 "ch_sim"
- (nullable instancetype)initWithModelDirectory:(NSString *)modelDirectory
                                       language:(NSString *)language;

/// 辨識影像中的文字
/// @param image  輸入影像
/// @param error  失敗時回傳錯誤
/// @return OCRResult 或 nil
- (nullable OCRResult *)recognizeImage:(PlatformImage *)image
                                 error:(NSError **)error;

/// 辨識影像中特定區域的文字 (Regional Re-OCR)
/// @param image  輸入影像
/// @param rect   目標區域
/// @param error  失敗時回傳錯誤
/// @return OCRResult 或 nil
- (nullable OCRResult *)recognizeRegionInImage:(PlatformImage *)image
                                        inRect:(CGRect)rect
                                         error:(NSError **)error
    NS_SWIFT_NAME(recognizeRegion(inImage:rect:));

/// 移除影像中指定位置的文字（修復背景）
/// @param image     輸入影像
/// @param locations 要移除的區域陣列 (OCRBoundingBox)
/// @param error     失敗時回傳錯誤
/// @return 處理後的影像或 nil
- (nullable PlatformImage *)removeTextFromImage:(PlatformImage *)image
                              atLocations:(NSArray<OCRBoundingBox *> *)locations
                                    error:(NSError **)error;

/// 替換影像中指定位置的文字
/// @param image    輸入影像
/// @param location 替換目標位置
/// @param newText  新文字內容
/// @param fontName 字體名稱（可為 nil 使用預設）
/// @param error    失敗時回傳錯誤
/// @return 處理後的影像或 nil
- (nullable PlatformImage *)replaceTextInImage:(PlatformImage *)image
                              atLocation:(OCRBoundingBox *)location
                             withNewText:(NSString *)newText
                                fontName:(nullable NSString *)fontName
                                   error:(NSError **)error;

/// 解析 PPTX 簡報並輸出圖層架構 JSON 字串
/// @param pptxPath PPTX 檔案的完整路徑
/// @param error    失敗時回傳錯誤
/// @return 圖層 JSON 字串或 nil
- (nullable NSString *)parsePptxFile:(NSString *)pptxPath
                               error:(NSError **)error;

// ============================================================
// Project Archive API (.ocrproj)
// ============================================================

/// 儲存 OCR 專案 (.ocrproj)
/// @param imagePath 圖片路徑
/// @param jsonState JSON 狀態字串
/// @param outputPath 輸出的 .ocrproj 路徑
/// @return 成功回傳 YES，失敗回傳 NO
+ (BOOL)saveProjectArchiveWithImagePath:(NSString *)imagePath
                              jsonState:(NSString *)jsonState
                             outputPath:(NSString *)outputPath;

/// 讀取 OCR 專案 (.ocrproj)
/// @param inputPath 輸入的 .ocrproj 路徑
/// @param outImagePath 解析出的圖片路徑 (out)
/// @param outJsonState 解析出的 JSON 狀態字串 (out)
/// @return 成功回傳 YES，失敗回傳 NO
+ (BOOL)loadProjectArchiveFromPath:(NSString *)inputPath
                      outImagePath:(NSString * _Nullable * _Nonnull)outImagePath
                      outJsonState:(NSString * _Nullable * _Nonnull)outJsonState;

// ============================================================
// Local LLM API
// ============================================================

/// Load a GGUF model for Local LLM features
/// @param modelPath Path to the GGUF model file
/// @return YES on success, NO on failure
- (BOOL)loadLLMModel:(NSString *)modelPath;

/// Fix broken OCR text using Local LLM
/// @param text The broken OCR text
/// @param error  失敗時回傳錯誤
/// @return Corrected text or nil
- (nullable NSString *)fixTextWithLLM:(NSString *)text error:(NSError **)error;

/// Translate text using Local LLM
/// @param text The source text
/// @param targetLang Target language (e.g. "English", "Traditional Chinese")
/// @param error  失敗時回傳錯誤
/// @return Translated text or nil
- (nullable NSString *)translateTextWithLLM:(NSString *)text toLanguage:(NSString *)targetLang error:(NSError **)error;

/// Extract entities to JSON using Local LLM
/// @param text The source text
/// @param error  失敗時回傳錯誤
/// @return Extracted entities as JSON string or nil
- (nullable NSString *)extractEntitiesWithLLM:(NSString *)text error:(NSError **)error;

// ============================================================
// Export & Formatting API
// ============================================================
/// Export the OCR JSON result to a structured Markdown string.
/// @param jsonStr The Positional Text Tree JSON string returned by ocr_recognize.
+ (nullable NSString *)exportMarkdownFromJson:(NSString *)jsonStr;

// ============================================================
// Settings & Sync API
// ============================================================
+ (void)initializeSettingsWithFilePath:(NSString *)filePath;
+ (BOOL)syncSettingsFromJson:(NSString *)jsonString;
+ (NSString *)getAllSettingsJson;

+ (void)setStringSetting:(NSString *)value forKey:(NSString *)key;
+ (NSString *)stringSettingForKey:(NSString *)key defaultValue:(NSString *)defaultValue;

+ (void)setIntSetting:(NSInteger)value forKey:(NSString *)key;
+ (NSInteger)intSettingForKey:(NSString *)key defaultValue:(NSInteger)defaultValue;

// ============================================================
// Document History API
// ============================================================
+ (void)initializeHistoryWithFilePath:(NSString *)filePath;
+ (BOOL)saveDocumentToHistoryWithId:(NSString *)docId json:(NSString *)json title:(NSString *)title previewImagePath:(nullable NSString *)previewPath;
+ (BOOL)deleteDocumentFromHistory:(NSString *)docId;
+ (NSString *)getAllDocumentsFromHistory;
+ (NSString *)getDocumentDataFromHistory:(NSString *)docId;

@end

NS_ASSUME_NONNULL_END
