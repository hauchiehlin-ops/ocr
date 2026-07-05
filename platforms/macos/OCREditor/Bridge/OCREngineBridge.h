//
//  OCREngineBridge.h
//  OCREditor
//
//  macOS 平台橋接層 — 將 C++ OCR Core API 封裝為 Objective-C 介面供 Swift 呼叫
//

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

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
@property (nonatomic, strong, nullable) NSColor *estimatedColor;  ///< 推估文字顏色
@property (nonatomic, assign) BOOL         isBold;         ///< 是否粗體

- (instancetype)initWithText:(NSString *)text
                  confidence:(CGFloat)confidence
                 boundingBox:(OCRBoundingBox *)boundingBox
           estimatedFontSize:(CGFloat)fontSize
              estimatedColor:(nullable NSColor *)color
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

- (instancetype)initWithImageDimensions:(CGSize)dimensions
                             textBlocks:(NSArray<OCRTextBlock *> *)textBlocks;

@end

#pragma mark - OCREngineBridge

/// OCR 引擎橋接物件 — 包裝 C++ 核心引擎
@interface OCREngineBridge : NSObject

/// 引擎是否就緒
@property (nonatomic, readonly, getter=isReady) BOOL ready;

/// 以模型目錄路徑初始化引擎
/// @param modelDirectory 模型檔案所在目錄
- (nullable instancetype)initWithModelDirectory:(NSString *)modelDirectory;

/// 辨識影像中的文字
/// @param image  輸入影像
/// @param error  失敗時回傳錯誤
/// @return OCRResult 或 nil
- (nullable OCRResult *)recognizeImage:(NSImage *)image
                                 error:(NSError **)error;

/// 移除影像中指定位置的文字（修復背景）
/// @param image     輸入影像
/// @param locations 要移除的區域陣列 (OCRBoundingBox)
/// @param error     失敗時回傳錯誤
/// @return 處理後的影像或 nil
- (nullable NSImage *)removeTextFromImage:(NSImage *)image
                              atLocations:(NSArray<OCRBoundingBox *> *)locations
                                    error:(NSError **)error;

/// 替換影像中指定位置的文字
/// @param image    輸入影像
/// @param location 替換目標位置
/// @param newText  新文字內容
/// @param fontName 字體名稱（可為 nil 使用預設）
/// @param error    失敗時回傳錯誤
/// @return 處理後的影像或 nil
- (nullable NSImage *)replaceTextInImage:(NSImage *)image
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

@end

NS_ASSUME_NONNULL_END
