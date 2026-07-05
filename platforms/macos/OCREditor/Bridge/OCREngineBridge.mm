//
//  OCREngineBridge.mm
//  OCREditor
//
//  macOS 平台橋接層實作 — Objective-C++ 包裝 C API
//

#import "OCREngineBridge.h"

// C++ 核心 API 標頭
extern "C" {
#import "ocr_core_api.h"
}

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
              estimatedColor:(nullable NSColor *)color
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
                             textBlocks:(NSArray<OCRTextBlock *> *)textBlocks {
    self = [super init];
    if (self) {
        _imageDimensions = dimensions;
        _textBlocks      = [textBlocks copy];
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

- (nullable instancetype)initWithModelDirectory:(NSString *)modelDirectory {
    self = [super init];
    if (self) {
        const char *path = [modelDirectory fileSystemRepresentation];
        _engineHandle = ocr_engine_create(path, NULL);
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

- (nullable OCRResult *)recognizeImage:(NSImage *)image
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
    const char *resultJSON = ocr_recognize(_engineHandle,
                                           pixelData,
                                           (int)width,
                                           (int)height,
                                           4 /* RGBA channels */);
    free(pixelData);

    if (resultJSON == NULL) {
        if (error) {
            *error = [self errorWithCode:1003 message:@"OCR 辨識失敗，引擎回傳 NULL"];
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

- (nullable NSImage *)removeTextFromImage:(NSImage *)image
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
    OCRImageResult *imgResult = ocr_remove_text(_engineHandle,
                                                pixelData,
                                                (int)width,
                                                (int)height,
                                                4,
                                                cBBoxes,
                                                locationCount);
    free(pixelData);
    free(cBBoxes);

    if (imgResult == NULL) {
        if (error) {
            *error = [self errorWithCode:1004 message:@"文字移除失敗"];
        }
        return nil;
    }

    NSImage *resultImage = [self imageFromPixelData:imgResult->data width:imgResult->width height:imgResult->height];
    ocr_free_image_result(imgResult);
    return resultImage;
}

#pragma mark - 文字替換

- (nullable NSImage *)replaceTextInImage:(NSImage *)image
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

    OCRImageResult *imgResult = ocr_replace_text(_engineHandle,
                                                 pixelData,
                                                 (int)width,
                                                 (int)height,
                                                 4,
                                                 &cBBox,
                                                 cText,
                                                 cFontConfig);
    free(pixelData);

    if (imgResult == NULL) {
        if (error) {
            *error = [self errorWithCode:1005 message:@"文字替換失敗"];
        }
        return nil;
    }

    NSImage *resultImage = [self imageFromPixelData:imgResult->data width:imgResult->width height:imgResult->height];
    ocr_free_image_result(imgResult);
    return resultImage;
}

#pragma mark - 私有工具方法

/// 從 NSImage 提取 RGBA 像素資料
/// @return 呼叫端負責 free() 的 uint8_t* 緩衝區，失敗回傳 NULL
- (nullable uint8_t *)pixelDataFromImage:(NSImage *)image
                                   width:(NSInteger *)outWidth
                                  height:(NSInteger *)outHeight {
    NSBitmapImageRep *bitmapRep = nil;

    // 嘗試取得既有的 bitmap 表示
    for (NSImageRep *rep in image.representations) {
        if ([rep isKindOfClass:[NSBitmapImageRep class]]) {
            bitmapRep = (NSBitmapImageRep *)rep;
            break;
        }
    }

    // 若無 bitmap 表示，繪製到 CGContext 取得
    if (bitmapRep == nil) {
        CGSize size = image.size;
        NSInteger pixelWidth  = (NSInteger)size.width;
        NSInteger pixelHeight = (NSInteger)size.height;

        // 使用 tiffRepresentation 轉換
        NSData *tiffData = [image TIFFRepresentation];
        if (tiffData) {
            bitmapRep = [[NSBitmapImageRep alloc] initWithData:tiffData];
        }

        if (bitmapRep == nil) {
            NSLog(@"[OCREngineBridge] ❌ 無法建立 BitmapImageRep");
            return NULL;
        }
    }

    NSInteger pixelWidth  = bitmapRep.pixelsWide;
    NSInteger pixelHeight = bitmapRep.pixelsHigh;

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
    CGImageRef cgImage = [bitmapRep CGImage];
    CGContextDrawImage(ctx, CGRectMake(0, 0, pixelWidth, pixelHeight), cgImage);
    CGContextRelease(ctx);

    *outWidth  = pixelWidth;
    *outHeight = pixelHeight;
    return buffer;
}

/// 從 RGBA 像素資料建立 NSImage
- (nullable NSImage *)imageFromPixelData:(const uint8_t *)pixels
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

    NSImage *result = [[NSImage alloc] initWithCGImage:cgImage
                                                  size:NSMakeSize(width, height)];
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
                NSColor *color = nil;
                NSDictionary *colorDict = wordDict[@"color"];
                if ([colorDict isKindOfClass:[NSDictionary class]]) {
                    CGFloat r = [colorDict[@"r"] doubleValue] / 255.0;
                    CGFloat g = [colorDict[@"g"] doubleValue] / 255.0;
                    CGFloat b = [colorDict[@"b"] doubleValue] / 255.0;
                    CGFloat a = colorDict[@"a"] ? [colorDict[@"a"] doubleValue] / 255.0 : 1.0;
                    color = [NSColor colorWithRed:r green:g blue:b alpha:a];
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

    return [[OCRResult alloc] initWithImageDimensions:dimensions textBlocks:blocks];
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

@end
