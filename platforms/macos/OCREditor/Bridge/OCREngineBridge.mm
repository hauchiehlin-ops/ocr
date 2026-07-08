//
//  OCREngineBridge.mm
//  OCREditor
//
//  macOS 平台橋接層實作 — Objective-C++ 包裝 C API
//

#import "OCREngineBridge.h"
#include "ocr_core_api.h"
#include <dlfcn.h>

#import <Foundation/Foundation.h>

#pragma mark - OCRBoundingBox 實作

@implementation OCRBoundingBox

- (instancetype)initWithTopLeft:(CGPoint)topLeft
                       topRight:(CGPoint)topRight
                    bottomRight:(CGPoint)bottomRight
                     bottomLeft:(CGPoint)bottomLeft {
    self = [super init];
    if (self) {
        _topLeft     = topLeft;
        _topRight    = topRight;
        _bottomRight = bottomRight;
        _bottomLeft  = bottomLeft;
    }
    return self;
}

- (CGRect)boundingRect {
    CGFloat minX = fmin(fmin(_topLeft.x, _bottomLeft.x), fmin(_topRight.x, _bottomRight.x));
    CGFloat minY = fmin(fmin(_topLeft.y, _topRight.y), fmin(_bottomLeft.y, _bottomRight.y));
    CGFloat maxX = fmax(fmax(_topLeft.x, _bottomLeft.x), fmax(_topRight.x, _bottomRight.x));
    CGFloat maxY = fmax(fmax(_topLeft.y, _topRight.y), fmax(_bottomLeft.y, _bottomRight.y));
    return CGRectMake(minX, minY, maxX - minX, maxY - minY);
}

- (CGPoint)center {
    CGRect rect = self.boundingRect;
    return CGPointMake(CGRectGetMidX(rect), CGRectGetMidY(rect));
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<OCRBoundingBox TL=(%.1f,%.1f) TR=(%.1f,%.1f) BR=(%.1f,%.1f) BL=(%.1f,%.1f)>",
            _topLeft.x, _topLeft.y, _topRight.x, _topRight.y,
            _bottomRight.x, _bottomRight.y, _bottomLeft.x, _bottomLeft.y];
}

@end

#pragma mark - OCRWord 實作

@implementation OCRWord

- (instancetype)initWithText:(NSString *)text
                  confidence:(CGFloat)confidence
                 boundingBox:(OCRBoundingBox *)boundingBox
           estimatedFontSize:(CGFloat)fontSize
              estimatedColor:(nullable PlatformColor *)color
                      isBold:(BOOL)isBold {
    self = [super init];
    if (self) {
        _text              = [text copy];
        _confidence        = confidence;
        _boundingBox       = boundingBox;
        _estimatedFontSize = fontSize;
        _estimatedColor    = color;
        _isBold            = isBold;
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<OCRWord '%@' conf=%.2f>", _text, _confidence];
}

@end

#pragma mark - OCRLine 實作

@implementation OCRLine

- (instancetype)initWithText:(NSString *)text
                  confidence:(CGFloat)confidence
                 boundingBox:(OCRBoundingBox *)boundingBox
                       words:(NSArray<OCRWord *> *)words {
    self = [super init];
    if (self) {
        _text        = [text copy];
        _confidence  = confidence;
        _boundingBox = boundingBox;
        _words       = [words copy];
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<OCRLine '%@' words=%lu conf=%.2f>",
            _text, (unsigned long)_words.count, _confidence];
}

@end

#pragma mark - OCRTextBlock 實作

@implementation OCRTextBlock

- (instancetype)initWithIdentifier:(NSString *)identifier
                              type:(NSString *)type
                        confidence:(CGFloat)confidence
                       boundingBox:(OCRBoundingBox *)boundingBox
                             lines:(NSArray<OCRLine *> *)lines {
    self = [super init];
    if (self) {
        _identifier  = [identifier copy];
        _type        = [type copy];
        _confidence  = confidence;
        _boundingBox = boundingBox;
        _lines       = [lines copy];
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<OCRTextBlock '%@' type=%@ lines=%lu conf=%.2f>",
            _identifier, _type, (unsigned long)_lines.count, _confidence];
}

@end

#pragma mark - OCRResult 實作

@implementation OCRResult

- (instancetype)initWithImageDimensions:(CGSize)dimensions
                             textBlocks:(NSArray<OCRTextBlock *> *)textBlocks
                                rawJson:(NSString *)rawJson {
    self = [super init];
    if (self) {
        _imageDimensions = dimensions;
        _textBlocks = [textBlocks copy];
        _rawJson = [rawJson copy];
    }
    return self;
}

/// 全文：串接所有區塊中所有行的文字，以換行分隔
- (NSString *)fullText {
    NSMutableArray<NSString *> *allLines = [NSMutableArray array];
    for (OCRTextBlock *block in _textBlocks) {
        for (OCRLine *line in block.lines) {
            if (line.text.length > 0) {
                [allLines addObject:line.text];
            }
        }
        // 區塊間加一空行
        [allLines addObject:@""];
    }
    // 移除尾部空行
    while (allLines.count > 0 && [allLines.lastObject isEqualToString:@""]) {
        [allLines removeLastObject];
    }
    return [allLines componentsJoinedByString:@"\n"];
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<OCRResult %dx%d blocks=%lu>",
            (int)_imageDimensions.width, (int)_imageDimensions.height,
            (unsigned long)_textBlocks.count];
}

@end

#pragma mark - OCREngineBridge 私有介面

@interface OCREngineBridge () {
    OCRHandle *_engineHandle;  ///< C API 引擎控制代碼
}
@end

@implementation OCREngineBridge

#pragma mark 生命週期

- (nullable instancetype)initWithModelDirectory:(NSString *)modelDirectory
                                       language:(NSString *)language {
    self = [super init];
    if (self) {
        const char *path = [modelDirectory fileSystemRepresentation];
        NSString *configJson = [NSString stringWithFormat:@"{\"language\":\"%@\"}", language ?: @"ch_tra,eng"];
        _engineHandle = ocr_engine_create(path, [configJson UTF8String]);
        if (_engineHandle == NULL) {
            NSLog(@"[OCREngineBridge] ❌ 無法以路徑初始化引擎: %@", modelDirectory);
            return nil;
        }
        NSLog(@"[OCREngineBridge] ✅ 引擎初始化成功，模型目錄: %@", modelDirectory);
    }
    return self;
}

- (void)dealloc {
    if (_engineHandle != NULL) {
        ocr_engine_destroy(_engineHandle);
        _engineHandle = NULL;
        NSLog(@"[OCREngineBridge] 🗑️ 引擎已釋放");
    }
}

- (BOOL)isReady {
    return (_engineHandle != NULL);
}

#pragma mark - 影像辨識

- (nullable OCRResult *)recognizeImage:(PlatformImage *)image
                                 error:(NSError **)error {
    if (![self isReady]) {
        if (error) {
            *error = [self errorWithCode:1001 message:@"OCR 引擎尚未初始化"];
        }
        return nil;
    }

    // 取得像素資料
    NSInteger width  = 0;
    NSInteger height = 0;
    uint8_t *pixelData = [self pixelDataFromImage:image width:&width height:&height];
    if (pixelData == NULL) {
        if (error) {
            *error = [self errorWithCode:1002 message:@"無法從影像提取像素資料"];
        }
        return nil;
    }

    // 呼叫 C API 進行辨識
    const char *resultJSON = NULL;
    @try {
        resultJSON = ocr_recognize(_engineHandle,
                                   pixelData,
                                   (int)width,
                                   (int)height,
                                   4 /* RGBA channels */);
    } @catch (NSException *exception) {
        NSLog(@"[OCREngineBridge] ❌ OCR 引擎發生 Objective-C 崩潰: %@", exception);
        if (error) {
            *error = [self errorWithCode:1004 message:[NSString stringWithFormat:@"OCR 內部崩潰: %@", exception.reason]];
        }
        free(pixelData);
        return nil;
    }
    free(pixelData);

    if (resultJSON == NULL) {
        if (error) {
            const char* lastErr = ocr_get_last_error(_engineHandle);
            NSString *errMsg = lastErr ? [NSString stringWithUTF8String:lastErr] : @"未知錯誤";
            if (lastErr) ocr_free_string(lastErr);
            *error = [self errorWithCode:1003 message:[NSString stringWithFormat:@"OCR 辨識失敗: %@", errMsg]];
        }
        return nil;
    }

    NSString *jsonString = [NSString stringWithUTF8String:resultJSON];
    ocr_free_string((char *)resultJSON);

    OCRResult *result = [self parseResultJSON:jsonString
                             imageDimensions:CGSizeMake(width, height)
                                       error:error];
    return result;
}

- (nullable OCRResult *)recognizeRegionInImage:(PlatformImage *)image
                                        inRect:(CGRect)rect
                                         error:(NSError **)error {
    if (![self isReady]) {
        if (error) {
            *error = [self errorWithCode:1001 message:@"OCR 引擎尚未初始化"];
        }
        return nil;
    }

    // 取得像素資料
    NSInteger width  = 0;
    NSInteger height = 0;
    uint8_t *pixelData = [self pixelDataFromImage:image width:&width height:&height];
    if (pixelData == NULL) {
        if (error) {
            *error = [self errorWithCode:1002 message:@"無法從影像提取像素資料"];
        }
        return nil;
    }

    // 呼叫 C API 進行區域辨識
    const char *resultJSON = NULL;
    @try {
        resultJSON = ocr_recognize_region(_engineHandle,
                                   pixelData,
                                   (int)width,
                                   (int)height,
                                   4 /* RGBA channels */,
                                   (int)rect.origin.x,
                                   (int)rect.origin.y,
                                   (int)rect.size.width,
                                   (int)rect.size.height);
    } @catch (NSException *exception) {
        NSLog(@"[OCREngineBridge] ❌ OCR 引擎發生 Objective-C 崩潰: %@", exception);
        if (error) {
            *error = [self errorWithCode:1004 message:[NSString stringWithFormat:@"OCR 內部崩潰: %@", exception.reason]];
        }
        free(pixelData);
        return nil;
    }
    free(pixelData);

    if (resultJSON == NULL) {
        if (error) {
            const char* lastErr = ocr_get_last_error(_engineHandle);
            NSString *errMsg = lastErr ? [NSString stringWithUTF8String:lastErr] : @"未知錯誤";
            if (lastErr) ocr_free_string(lastErr);
            *error = [self errorWithCode:1003 message:[NSString stringWithFormat:@"OCR 區域辨識失敗: %@", errMsg]];
        }
        return nil;
    }

    NSString *jsonString = [NSString stringWithUTF8String:resultJSON];
    ocr_free_string((char *)resultJSON);

    OCRResult *result = [self parseResultJSON:jsonString
                             imageDimensions:CGSizeMake(width, height)
                                       error:error];
    return result;
}

#pragma mark - 文字移除

- (nullable PlatformImage *)removeTextFromImage:(PlatformImage *)image
                              atLocations:(NSArray<OCRBoundingBox *> *)locations
                                    error:(NSError **)error {
    if (![self isReady]) {
        if (error) {
            *error = [self errorWithCode:1001 message:@"OCR 引擎尚未初始化"];
        }
        return nil;
    }

    NSInteger width  = 0;
    NSInteger height = 0;
    uint8_t *pixelData = [self pixelDataFromImage:image width:&width height:&height];
    if (pixelData == NULL) {
        if (error) {
            *error = [self errorWithCode:1002 message:@"無法從影像提取像素資料"];
        }
        return nil;
    }

    // 將 ObjC 座標陣列轉為 C 結構 OCRBBox
    int locationCount = (int)locations.count;
    OCRBBox *cBBoxes = (OCRBBox *)malloc(sizeof(OCRBBox) * locationCount);
    for (int i = 0; i < locationCount; i++) {
        OCRBoundingBox *loc = locations[i];
        cBBoxes[i].top_left[0]     = (float)loc.topLeft.x;
        cBBoxes[i].top_left[1]     = (float)loc.topLeft.y;
        cBBoxes[i].top_right[0]    = (float)loc.topRight.x;
        cBBoxes[i].top_right[1]    = (float)loc.topRight.y;
        cBBoxes[i].bottom_right[0] = (float)loc.bottomRight.x;
        cBBoxes[i].bottom_right[1] = (float)loc.bottomRight.y;
        cBBoxes[i].bottom_left[0]  = (float)loc.bottomLeft.x;
        cBBoxes[i].bottom_left[1]  = (float)loc.bottomLeft.y;
    }

    // 呼叫 C API
    OCRImageResult *imgResult = NULL;
    @try {
        imgResult = ocr_remove_text(_engineHandle,
                                    pixelData,
                                    (int)width,
                                    (int)height,
                                    4,
                                    cBBoxes,
                                    locationCount);
    } @catch (NSException *exception) {
        NSLog(@"[OCREngineBridge] ❌ OCR 文字移除發生 Objective-C 崩潰: %@", exception);
        if (error) {
            *error = [self errorWithCode:1004 message:[NSString stringWithFormat:@"文字移除內部崩潰: %@", exception.reason]];
        }
        free(pixelData);
        free(cBBoxes);
        return nil;
    }
    free(pixelData);
    free(cBBoxes);

    if (imgResult == NULL) {
        if (error) {
            const char* lastErr = ocr_get_last_error(_engineHandle);
            NSString *errMsg = lastErr ? [NSString stringWithUTF8String:lastErr] : @"未知錯誤";
            if (lastErr) ocr_free_string(lastErr);
            *error = [self errorWithCode:1004 message:[NSString stringWithFormat:@"文字移除失敗: %@", errMsg]];
        }
        return nil;
    }

    PlatformImage *resultImage = [self imageFromPixelData:imgResult->data width:imgResult->width height:imgResult->height];
    ocr_free_image_result(imgResult);
    return resultImage;
}

#pragma mark - 文字替換

- (nullable PlatformImage *)replaceTextInImage:(PlatformImage *)image
                              atLocation:(OCRBoundingBox *)location
                             withNewText:(NSString *)newText
                                fontName:(nullable NSString *)fontName
                                   error:(NSError **)error {
    if (![self isReady]) {
        if (error) {
            *error = [self errorWithCode:1001 message:@"OCR 引擎尚未初始化"];
        }
        return nil;
    }

    NSInteger width  = 0;
    NSInteger height = 0;
    uint8_t *pixelData = [self pixelDataFromImage:image width:&width height:&height];
    if (pixelData == NULL) {
        if (error) {
            *error = [self errorWithCode:1002 message:@"無法從影像提取像素資料"];
        }
        return nil;
    }

    OCRBBox cBBox;
    cBBox.top_left[0]     = (float)location.topLeft.x;
    cBBox.top_left[1]     = (float)location.topLeft.y;
    cBBox.top_right[0]    = (float)location.topRight.x;
    cBBox.top_right[1]    = (float)location.topRight.y;
    cBBox.bottom_right[0] = (float)location.bottomRight.x;
    cBBox.bottom_right[1] = (float)location.bottomRight.y;
    cBBox.bottom_left[0]  = (float)location.bottomLeft.x;
    cBBox.bottom_left[1]  = (float)location.bottomLeft.y;

    const char *cText = [newText UTF8String];
    
    // 將字體名稱轉換為 JSON 格式 font_config_json
    NSString *fontConfigJson = nil;
    if (fontName) {
        fontConfigJson = [NSString stringWithFormat:@"{\"font_name\":\"%@\"}", fontName];
    }
    const char *cFontConfig = fontConfigJson ? [fontConfigJson UTF8String] : NULL;

    OCRImageResult *imgResult = NULL;
    @try {
        imgResult = ocr_replace_text(_engineHandle,
                                     pixelData,
                                     (int)width,
                                     (int)height,
                                     4,
                                     &cBBox,
                                     cText,
                                     cFontConfig);
    } @catch (NSException *exception) {
        NSLog(@"[OCREngineBridge] ❌ OCR 文字替換發生 Objective-C 崩潰: %@", exception);
        if (error) {
            *error = [self errorWithCode:1005 message:[NSString stringWithFormat:@"文字替換內部崩潰: %@", exception.reason]];
        }
        free(pixelData);
        return nil;
    }
    free(pixelData);

    if (imgResult == NULL) {
        if (error) {
            const char* lastErr = ocr_get_last_error(_engineHandle);
            NSString *errMsg = lastErr ? [NSString stringWithUTF8String:lastErr] : @"未知錯誤";
            if (lastErr) ocr_free_string(lastErr);
            *error = [self errorWithCode:1005 message:[NSString stringWithFormat:@"文字替換失敗: %@", errMsg]];
        }
        return nil;
    }

    PlatformImage *resultImage = [self imageFromPixelData:imgResult->data width:imgResult->width height:imgResult->height];
    ocr_free_image_result(imgResult);
    return resultImage;
}

#pragma mark - 私有工具方法

/// 從 PlatformImage 提取 RGBA 像素資料
/// @return 呼叫端負責 free() 的 uint8_t* 緩衝區，失敗回傳 NULL
- (nullable uint8_t *)pixelDataFromImage:(PlatformImage *)image
                                   width:(NSInteger *)outWidth
                                  height:(NSInteger *)outHeight {
#if TARGET_OS_OSX
    CGImageRef cgImage = [image CGImageForProposedRect:nil context:nil hints:nil];
#else
    CGImageRef cgImage = image.CGImage;
#endif

    if (cgImage == NULL) {
        NSLog(@"[OCREngineBridge] ❌ 無法取得 CGImage");
        return NULL;
    }

    NSInteger pixelWidth  = CGImageGetWidth(cgImage);
    NSInteger pixelHeight = CGImageGetHeight(cgImage);

    // 建立 RGBA CGBitmapContext
    NSInteger bytesPerRow = pixelWidth * 4;
    uint8_t *buffer = (uint8_t *)calloc(pixelHeight * bytesPerRow, sizeof(uint8_t));
    if (buffer == NULL) {
        NSLog(@"[OCREngineBridge] ❌ 記憶體配置失敗");
        return NULL;
    }

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(buffer,
                                             pixelWidth,
                                             pixelHeight,
                                             8,
                                             bytesPerRow,
                                             colorSpace,
                                             kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colorSpace);

    if (ctx == NULL) {
        free(buffer);
        NSLog(@"[OCREngineBridge] ❌ 無法建立 CGBitmapContext");
        return NULL;
    }

    // 繪製影像到 context
    CGContextDrawImage(ctx, CGRectMake(0, 0, pixelWidth, pixelHeight), cgImage);
    CGContextRelease(ctx);

    *outWidth  = pixelWidth;
    *outHeight = pixelHeight;
    return buffer;
}

/// 從 RGBA 像素資料建立 PlatformImage
- (nullable PlatformImage *)imageFromPixelData:(const uint8_t *)pixels
                                   width:(NSInteger)width
                                  height:(NSInteger)height {
    NSInteger bytesPerRow = width * 4;
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate((void *)pixels,
                                             width, height,
                                             8, bytesPerRow,
                                             colorSpace,
                                             kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colorSpace);

    if (ctx == NULL) {
        return nil;
    }

    CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);

    if (cgImage == NULL) {
        return nil;
    }

#if TARGET_OS_OSX
    PlatformImage *result = [[PlatformImage alloc] initWithCGImage:cgImage
                                                  size:NSMakeSize(width, height)];
#else
    PlatformImage *result = [[PlatformImage alloc] initWithCGImage:cgImage];
#endif
    CGImageRelease(cgImage);
    return result;
}

/// 解析 C API 回傳的 JSON 字串為 OCRResult
- (nullable OCRResult *)parseResultJSON:(NSString *)jsonString
                        imageDimensions:(CGSize)dimensions
                                  error:(NSError **)error {
    NSData *jsonData = [jsonString dataUsingEncoding:NSUTF8StringEncoding];
    if (jsonData == nil) {
        if (error) {
            *error = [self errorWithCode:2001 message:@"JSON 字串編碼錯誤"];
        }
        return nil;
    }

    NSError *parseError = nil;
    NSDictionary *root = [NSJSONSerialization JSONObjectWithData:jsonData
                                                        options:0
                                                          error:&parseError];
    if (parseError || ![root isKindOfClass:[NSDictionary class]]) {
        if (error) {
            *error = [self errorWithCode:2002
                                 message:[NSString stringWithFormat:@"JSON 解析失敗: %@",
                                          parseError.localizedDescription]];
        }
        return nil;
    }

    // 解析文字區塊
    NSArray *blocksJSON = root[@"text_blocks"];
    NSMutableArray<OCRTextBlock *> *blocks = [NSMutableArray array];

    for (NSDictionary *blockDict in blocksJSON) {
        if (![blockDict isKindOfClass:[NSDictionary class]]) continue;

        NSString *identifier = blockDict[@"id"] ?: [[NSUUID UUID] UUIDString];
        NSString *type       = blockDict[@"type"] ?: @"unknown";
        CGFloat blockConf    = [blockDict[@"confidence"] doubleValue];
        OCRBoundingBox *blockBBox = [self parseBBox:blockDict[@"bounding_box"]];

        // 解析行
        NSArray *linesJSON = blockDict[@"lines"];
        NSMutableArray<OCRLine *> *lines = [NSMutableArray array];

        for (NSDictionary *lineDict in linesJSON) {
            if (![lineDict isKindOfClass:[NSDictionary class]]) continue;

            NSString *lineText  = lineDict[@"text"] ?: @"";
            CGFloat lineConf    = [lineDict[@"confidence"] doubleValue];
            OCRBoundingBox *lineBBox = [self parseBBox:lineDict[@"bounding_box"]];

            // 解析詞彙
            NSArray *wordsJSON = lineDict[@"words"];
            NSMutableArray<OCRWord *> *words = [NSMutableArray array];

            for (NSDictionary *wordDict in wordsJSON) {
                if (![wordDict isKindOfClass:[NSDictionary class]]) continue;

                NSString *wordText = wordDict[@"text"] ?: @"";
                CGFloat wordConf   = [wordDict[@"confidence"] doubleValue];
                OCRBoundingBox *wordBBox = [self parseBBox:wordDict[@"bounding_box"]];
                CGFloat fontSize   = [wordDict[@"font_size"] doubleValue];
                BOOL isBold        = [wordDict[@"is_bold"] boolValue];

                // 解析顏色（如有提供 RGBA）
                PlatformColor *color = nil;
                NSDictionary *colorDict = wordDict[@"color"];
                if ([colorDict isKindOfClass:[NSDictionary class]]) {
                    CGFloat r = [colorDict[@"r"] doubleValue] / 255.0;
                    CGFloat g = [colorDict[@"g"] doubleValue] / 255.0;
                    CGFloat b = [colorDict[@"b"] doubleValue] / 255.0;
                    CGFloat a = colorDict[@"a"] ? [colorDict[@"a"] doubleValue] / 255.0 : 1.0;
                    color = [PlatformColor colorWithRed:r green:g blue:b alpha:a];
                }

                OCRWord *word = [[OCRWord alloc] initWithText:wordText
                                                   confidence:wordConf
                                                  boundingBox:wordBBox
                                            estimatedFontSize:fontSize
                                               estimatedColor:color
                                                       isBold:isBold];
                [words addObject:word];
            }

            OCRLine *line = [[OCRLine alloc] initWithText:lineText
                                               confidence:lineConf
                                              boundingBox:lineBBox
                                                    words:words];
            [lines addObject:line];
        }

        OCRTextBlock *block = [[OCRTextBlock alloc] initWithIdentifier:identifier
                                                                  type:type
                                                            confidence:blockConf
                                                           boundingBox:blockBBox
                                                                 lines:lines];
        [blocks addObject:block];
    }

    return [[OCRResult alloc] initWithImageDimensions:dimensions textBlocks:blocks rawJson:jsonString];
}

/// 從 JSON 字典解析 OCRBoundingBox
- (OCRBoundingBox *)parseBBox:(nullable NSDictionary *)dict {
    if (![dict isKindOfClass:[NSDictionary class]]) {
        return [[OCRBoundingBox alloc] initWithTopLeft:CGPointZero
                                             topRight:CGPointZero
                                          bottomRight:CGPointZero
                                           bottomLeft:CGPointZero];
    }

    CGPoint tl = [self pointFromArray:dict[@"top_left"]];
    CGPoint tr = [self pointFromArray:dict[@"top_right"]];
    CGPoint br = [self pointFromArray:dict[@"bottom_right"]];
    CGPoint bl = [self pointFromArray:dict[@"bottom_left"]];

    return [[OCRBoundingBox alloc] initWithTopLeft:tl
                                         topRight:tr
                                      bottomRight:br
                                       bottomLeft:bl];
}

/// 從 [x, y] 陣列解析 CGPoint
- (CGPoint)pointFromArray:(nullable NSArray *)array {
    if (![array isKindOfClass:[NSArray class]] || array.count < 2) {
        return CGPointZero;
    }
    return CGPointMake([array[0] doubleValue], [array[1] doubleValue]);
}

/// 建立 NSError
- (NSError *)errorWithCode:(NSInteger)code message:(NSString *)message {
    return [NSError errorWithDomain:@"com.ocr-editor.bridge"
                              code:code
                          userInfo:@{NSLocalizedDescriptionKey: message}];
}

- (nullable NSString *)parsePptxFile:(NSString *)pptxPath
                               error:(NSError **)error {
    if (_engineHandle == NULL) {
        if (error) *error = [self errorWithCode:100 message:@"引擎尚未初始化"];
        return nil;
    }

    const char *path = [pptxPath fileSystemRepresentation];
    const char *jsonResult = ocr_parse_pptx(_engineHandle, path);

    if (jsonResult == NULL) {
        if (error) *error = [self errorWithCode:200 message:@"PPTX 解析失敗"];
        return nil;
    }

    NSString *result = [NSString stringWithUTF8String:jsonResult];
    ocr_free_string(jsonResult);
    return result;
}

#pragma mark // ============================================================
// Local LLM API
// ============================================================

- (BOOL)loadLLMModel:(NSString *)modelPath {
    if (_engineHandle == NULL || modelPath == nil) return NO;
    const char *path = [modelPath fileSystemRepresentation];
    return ocr_llm_load_model(_engineHandle, path) != 0;
}

- (nullable NSString *)fixTextWithLLM:(NSString *)text error:(NSError **)error {
    if (_engineHandle == NULL) {
        if (error) *error = [self errorWithCode:100 message:@"引擎尚未初始化"];
        return nil;
    }
    if (!text) return nil;

    const char *result_c = ocr_llm_fix_text(_engineHandle, [text UTF8String]);
    if (result_c == NULL) {
        if (error) *error = [self errorWithCode:300 message:@"LLM 文字修復失敗"];
        return nil;
    }

    NSString *result = [NSString stringWithUTF8String:result_c];
    ocr_free_string(result_c);
    return result;
}

- (nullable NSString *)translateTextWithLLM:(NSString *)text toLanguage:(NSString *)targetLang error:(NSError **)error {
    if (_engineHandle == NULL) {
        if (error) *error = [self errorWithCode:100 message:@"引擎尚未初始化"];
        return nil;
    }
    if (!text || !targetLang) return nil;

    const char *result_c = ocr_llm_translate(_engineHandle, [text UTF8String], [targetLang UTF8String]);
    if (result_c == NULL) {
        if (error) *error = [self errorWithCode:301 message:@"LLM 翻譯失敗"];
        return nil;
    }

    NSString *result = [NSString stringWithUTF8String:result_c];
    ocr_free_string(result_c);
    return result;
}

- (nullable NSString *)extractEntitiesWithLLM:(NSString *)text error:(NSError **)error {
    if (_engineHandle == NULL) {
        if (error) *error = [self errorWithCode:100 message:@"引擎尚未初始化"];
        return nil;
    }
    if (!text) return nil;

    const char *result_c = ocr_llm_extract_entities(_engineHandle, [text UTF8String]);
    if (result_c == NULL) {
        if (error) *error = [self errorWithCode:302 message:@"LLM 實體萃取失敗"];
        return nil;
    }

    NSString *result = [NSString stringWithUTF8String:result_c];
    ocr_free_string(result_c);
    return result;
}

// ============================================================
// Project Archive API (.ocrproj)
// ============================================================
+ (BOOL)saveProjectArchiveWithImagePath:(NSString *)imagePath
                              jsonState:(NSString *)jsonState
                             outputPath:(NSString *)outputPath {
    if (!imagePath || !jsonState || !outputPath) return NO;
    int result = ocr_project_save([imagePath UTF8String], [jsonState UTF8String], [outputPath UTF8String]);
    return result == 1;
}

+ (BOOL)loadProjectArchiveFromPath:(NSString *)inputPath
                      outImagePath:(NSString * _Nullable * _Nonnull)outImagePath
                      outJsonState:(NSString * _Nullable * _Nonnull)outJsonState {
    if (!inputPath) return NO;
    char* imgPath = NULL;
    char* jsonState = NULL;
    int result = ocr_project_load([inputPath UTF8String], &imgPath, &jsonState);
    
    if (result == 1 && imgPath && jsonState) {
        *outImagePath = [NSString stringWithUTF8String:imgPath];
        *outJsonState = [NSString stringWithUTF8String:jsonState];
        ocr_free_string(imgPath);
        ocr_free_string(jsonState);
        return YES;
    }
    return NO;
}

#pragma mark // ============================================================
// Export & Formatting API
// ============================================================
+ (nullable NSString *)exportMarkdownFromJson:(NSString *)jsonStr {
    if (!jsonStr) return nil;
    
    // Resolve dynamic symbols
    static const char* (*export_md_func)(const char*) = NULL;
    static void (*free_str_func)(const char*) = NULL;
    
    if (!export_md_func || !free_str_func) {
        // Load dynamically similar to other functions or assume global symbol available if static linked
        // If the library is statically linked into the app or we use dlsym on main bundle:
        void* handle = dlopen(NULL, RTLD_LAZY);
        if (handle) {
            export_md_func = (const char* (*)(const char*))dlsym(handle, "ocr_export_markdown");
            free_str_func = (void (*)(const char*))dlsym(handle, "ocr_free_string");
            dlclose(handle);
        }
    }
    
    if (export_md_func && free_str_func) {
        const char *md_c = export_md_func([jsonStr UTF8String]);
        if (md_c) {
            NSString *result = [NSString stringWithUTF8String:md_c];
            free_str_func(md_c);
            return result;
        }
    }
    return nil;
}

// ============================================================
// Settings & Sync API
// ============================================================
+ (void)initializeSettingsWithFilePath:(NSString *)filePath {
    if (filePath) {
        ocr_settings_init([filePath UTF8String]);
    }
}

+ (BOOL)syncSettingsFromJson:(NSString *)jsonString {
    if (jsonString) {
        return ocr_settings_sync_from_json([jsonString UTF8String]) != 0;
    }
    return NO;
}

+ (NSString *)getAllSettingsJson {
    const char *cJson = ocr_settings_get_all_json();
    if (cJson) {
        NSString *jsonStr = [NSString stringWithUTF8String:cJson];
        ocr_free_string(cJson);
        return jsonStr;
    }
    return @"{}";
}

+ (void)setStringSetting:(NSString *)value forKey:(NSString *)key {
    if (key && value) {
        ocr_settings_set_string([key UTF8String], [value UTF8String]);
    }
}

+ (NSString *)stringSettingForKey:(NSString *)key defaultValue:(NSString *)defaultValue {
    if (key) {
        const char *cVal = ocr_settings_get_string([key UTF8String], defaultValue ? [defaultValue UTF8String] : "");
        if (cVal) {
            NSString *valStr = [NSString stringWithUTF8String:cVal];
            ocr_free_string(cVal);
            return valStr;
        }
    }
    return defaultValue ?: @"";
}

+ (void)setIntSetting:(NSInteger)value forKey:(NSString *)key {
    if (key) {
        ocr_settings_set_int([key UTF8String], (int)value);
    }
}

+ (NSInteger)intSettingForKey:(NSString *)key defaultValue:(NSInteger)defaultValue {
    if (key) {
        return ocr_settings_get_int([key UTF8String], (int)defaultValue);
    }
    return defaultValue;
}

// ============================================================
// Document History API
// ============================================================
+ (void)initializeHistoryWithFilePath:(NSString *)filePath {
    if (filePath) {
        ocr_history_init([filePath UTF8String]);
    }
}

+ (BOOL)saveDocumentToHistoryWithId:(NSString *)docId json:(NSString *)json title:(NSString *)title previewImagePath:(nullable NSString *)previewPath {
    if (docId && json && title) {
        return ocr_history_save_document([docId UTF8String], [json UTF8String], [title UTF8String], previewPath ? [previewPath UTF8String] : "") == 0;
    }
    return NO;
}

+ (BOOL)deleteDocumentFromHistory:(NSString *)docId {
    if (docId) {
        return ocr_history_delete_document([docId UTF8String]) == 0;
    }
    return NO;
}

+ (NSString *)getAllDocumentsFromHistory {
    const char *cJson = ocr_history_get_all_documents();
    if (cJson) {
        NSString *jsonStr = [NSString stringWithUTF8String:cJson];
        ocr_free_string(cJson);
        return jsonStr;
    }
    return @"[]";
}

+ (NSString *)getDocumentDataFromHistory:(NSString *)docId {
    if (docId) {
        const char *cJson = ocr_history_get_document_data([docId UTF8String]);
        if (cJson) {
            NSString *jsonStr = [NSString stringWithUTF8String:cJson];
            ocr_free_string(cJson);
            return jsonStr;
        }
    }
    return @"{}";
}

@end
