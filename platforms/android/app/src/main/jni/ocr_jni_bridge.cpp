/**
 * @file ocr_jni_bridge.cpp
 * @brief JNI bridge between Android (Java/Kotlin) and the native OCR core engine.
 *
 * This file implements the native methods declared in
 * `com.ocreditor.bridge.OCREngine`. It handles:
 *   - Engine lifecycle (create / destroy)
 *   - Bitmap pixel extraction via Android NDK bitmap helpers
 *   - OCR recognition returning a JSON-encoded result string
 *   - Text removal (inpainting) given bounding-box coordinates
 *   - Text replacement (stub – reserved for future implementation)
 *
 * Thread-safety: each `OCREngine` instance owns its native handle and must
 * not be shared across threads without external synchronisation.
 *
 * Build requirements:
 *   - Android NDK r25+
 *   - libjnigraphics (linked automatically via CMake/ndk-build)
 *   - ocr_core static/shared library (provides ocr_core_api.h)
 *
 * @copyright 2026 OCR Visual Editor Contributors
 * @license Apache-2.0
 */

#include <jni.h>
#include <android/bitmap.h>
#include <android/log.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// Project-specific C API header.
#include "ocr_core_api.h"

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/** @brief Android logcat tag used by all JNI bridge messages. */
#define LOG_TAG "OCR_JNI"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

namespace {

/**
 * @brief Extract RGBA pixel data from an Android `Bitmap` object.
 *
 * Locks the bitmap, copies pixel data into a contiguous `std::vector<uint8_t>`,
 * and unlocks the bitmap before returning.  The caller receives an
 * RGBA-ordered buffer regardless of the original bitmap configuration
 * (ARGB_8888 is converted in-place).
 *
 * @param env        JNI environment pointer.
 * @param bitmap     A non-null reference to an `android.graphics.Bitmap`.
 * @param[out] outWidth   Bitmap width in pixels.
 * @param[out] outHeight  Bitmap height in pixels.
 * @return Pixel data in RGBA order, or an empty vector on failure.
 */
std::vector<uint8_t> getBitmapPixels(JNIEnv* env,
                                     jobject bitmap,
                                     int* outWidth,
                                     int* outHeight) {
    AndroidBitmapInfo info;
    std::vector<uint8_t> pixels;

    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) {
        LOGE("getBitmapPixels: failed to get bitmap info");
        return pixels;
    }

    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("getBitmapPixels: unsupported format %d (expected RGBA_8888)", info.format);
        return pixels;
    }

    void* rawPixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &rawPixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        LOGE("getBitmapPixels: failed to lock pixels");
        return pixels;
    }

    *outWidth  = static_cast<int>(info.width);
    *outHeight = static_cast<int>(info.height);

    const size_t rowBytes   = info.stride;
    const size_t pixelBytes = static_cast<size_t>(info.width) * 4u;

    pixels.resize(static_cast<size_t>(info.width) * info.height * 4u);

    // Copy row-by-row to handle potential stride padding.
    const auto* src = static_cast<const uint8_t*>(rawPixels);
    for (uint32_t y = 0; y < info.height; ++y) {
        std::memcpy(pixels.data() + y * pixelBytes, src + y * rowBytes, pixelBytes);
    }

    AndroidBitmap_unlockPixels(env, bitmap);

    // Android RGBA_8888 is already in RGBA order – no swizzle needed.
    return pixels;
}

/**
 * @brief Throw a Java RuntimeException with the given message.
 */
void throwRuntimeException(JNIEnv* env, const char* message) {
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (cls != nullptr) {
        env->ThrowNew(cls, message);
    }
}

}  // anonymous namespace

// ---------------------------------------------------------------------------
// JNI exports
// ---------------------------------------------------------------------------

extern "C" {

/**
 * @brief Create a new OCR engine instance from bundled model files.
 *
 * @param env       JNI environment.
 * @param thiz      The calling Java/Kotlin object (unused).
 * @param modelDir  Absolute path to the directory containing model assets.
 * @return An opaque native handle (cast to `jlong`), or 0 on failure.
 */
JNIEXPORT jlong JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeCreate(JNIEnv* env,
                                                  jobject thiz,
                                                  jstring modelDir) {
    const char* modelDirCStr = env->GetStringUTFChars(modelDir, nullptr);
    if (modelDirCStr == nullptr) {
        LOGE("nativeCreate: modelDir string is null");
        return 0;
    }

    LOGI("nativeCreate: initialising engine with model dir = %s", modelDirCStr);
    OCRHandle* engine = ocr_engine_create(modelDirCStr, nullptr);
    env->ReleaseStringUTFChars(modelDir, modelDirCStr);

    if (engine == nullptr) {
        LOGE("nativeCreate: ocr_engine_create returned null");
        throwRuntimeException(env, "Failed to create native OCR engine");
        return 0;
    }

    LOGI("nativeCreate: engine created successfully (handle=%p)", engine);
    return reinterpret_cast<jlong>(engine);
}

/**
 * @brief Destroy a previously created OCR engine and free its resources.
 *
 * @param env    JNI environment.
 * @param thiz   The calling Java/Kotlin object (unused).
 * @param handle The native engine handle returned by `nativeCreate`.
 */
JNIEXPORT void JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeDestroy(JNIEnv* env,
                                                   jobject thiz,
                                                   jlong handle) {
    if (handle == 0) {
        LOGW("nativeDestroy: handle is null – nothing to destroy");
        return;
    }

    auto* engine = reinterpret_cast<OCRHandle*>(handle);
    LOGI("nativeDestroy: destroying engine (handle=%p)", engine);
    ocr_engine_destroy(engine);
}

/**
 * @brief Run OCR recognition on a bitmap and return a JSON result string.
 *
 * The returned JSON contains text blocks, lines, words, bounding boxes, and
 * confidence scores.  The format matches the `OCRResult` data class on the
 * Kotlin side.
 *
 * @param env    JNI environment.
 * @param thiz   The calling Java/Kotlin object (unused).
 * @param handle Native engine handle.
 * @param bitmap An `android.graphics.Bitmap` in RGBA_8888 format.
 * @return A `jstring` containing the JSON-encoded recognition result,
 *         or `null` on failure.
 */
JNIEXPORT jstring JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeRecognize(JNIEnv* env,
                                                     jobject thiz,
                                                     jlong handle,
                                                     jobject bitmap) {
    if (handle == 0) {
        LOGE("nativeRecognize: engine handle is null");
        return nullptr;
    }

    int width  = 0;
    int height = 0;
    std::vector<uint8_t> pixels = getBitmapPixels(env, bitmap, &width, &height);
    if (pixels.empty()) {
        LOGE("nativeRecognize: failed to extract bitmap pixels");
        return nullptr;
    }

    LOGD("nativeRecognize: bitmap %dx%d (%zu bytes)", width, height, pixels.size());

    auto* engine = reinterpret_cast<OCRHandle*>(handle);

    // The C API returns a heap-allocated JSON string that we must free.
    const char* jsonResult = ocr_recognize(engine,
                                           pixels.data(),
                                           width,
                                           height,
                                           /*channels=*/4);

    if (jsonResult == nullptr) {
        LOGE("nativeRecognize: ocr_recognize returned null");
        return nullptr;
    }

    jstring result = env->NewStringUTF(jsonResult);
    ocr_free_string(jsonResult);

    LOGI("nativeRecognize: recognition complete");
    return result;
}

/**
 * @brief Remove (inpaint) text regions identified by bounding boxes.
 *
 * @param env       JNI environment.
 * @param thiz      The calling Java/Kotlin object (unused).
 * @param handle    Native engine handle.
 * @param bitmap    Source bitmap (RGBA_8888).
 * @param bboxArray A `float[]` with groups of four values
 *                  `[x, y, width, height, ...]` for each region to remove.
 * @param bboxCount Number of bounding boxes (i.e. `bboxArray.length / 4`).
 * @return A new `Bitmap` with the specified text regions inpainted,
 *         or `null` on failure.
 */
JNIEXPORT jobject JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeRemoveText(JNIEnv* env,
                                                      jobject thiz,
                                                      jlong handle,
                                                      jobject bitmap,
                                                      jfloatArray bboxArray,
                                                      jint bboxCount) {
    if (handle == 0) {
        LOGE("nativeRemoveText: engine handle is null");
        return nullptr;
    }

    int width  = 0;
    int height = 0;
    std::vector<uint8_t> pixels = getBitmapPixels(env, bitmap, &width, &height);
    if (pixels.empty()) {
        LOGE("nativeRemoveText: failed to extract bitmap pixels");
        return nullptr;
    }

    // Unpack bounding boxes from the flat float array.
    jsize arrayLen = env->GetArrayLength(bboxArray);
    std::vector<float> bboxData(static_cast<size_t>(arrayLen));
    env->GetFloatArrayRegion(bboxArray, 0, arrayLen, bboxData.data());

    // Convert to the C API's bounding-box struct array (OCRBBox).
    std::vector<OCRBBox> boxes(static_cast<size_t>(bboxCount));
    for (int i = 0; i < bboxCount; ++i) {
        boxes[i] = ocr_bbox_from_rect(bboxData[i * 4 + 0],
                                      bboxData[i * 4 + 1],
                                      bboxData[i * 4 + 2],
                                      bboxData[i * 4 + 3]);
    }

    LOGD("nativeRemoveText: processing %d bounding boxes on %dx%d image",
         bboxCount, width, height);

    auto* engine = reinterpret_cast<OCRHandle*>(handle);

    OCRImageResult* imgResult = ocr_remove_text(engine,
                                                pixels.data(),
                                                width,
                                                height,
                                                /*channels=*/4,
                                                boxes.data(),
                                                bboxCount);

    if (imgResult == nullptr) {
        LOGE("nativeRemoveText: ocr_remove_text returned null");
        return nullptr;
    }

    // Create a new Android Bitmap from the result pixels.
    jclass bitmapClass  = env->FindClass("android/graphics/Bitmap");
    jmethodID createBmp = env->GetStaticMethodID(
        bitmapClass,
        "createBitmap",
        "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;");

    jclass configClass   = env->FindClass("android/graphics/Bitmap$Config");
    jfieldID argb8888    = env->GetStaticFieldID(configClass, "ARGB_8888",
                                                   "Landroid/graphics/Bitmap$Config;");
    jobject configObj    = env->GetStaticObjectField(configClass, argb8888);

    jobject resultBitmap = env->CallStaticObjectMethod(bitmapClass,
                                                       createBmp,
                                                       imgResult->width,
                                                       imgResult->height,
                                                       configObj);

    // Copy inpainted pixels into the new bitmap.
    void* resultPixels = nullptr;
    if (AndroidBitmap_lockPixels(env, resultBitmap, &resultPixels) == ANDROID_BITMAP_RESULT_SUCCESS) {
        const size_t totalBytes =
            static_cast<size_t>(imgResult->width) * imgResult->height * 4u;
        std::memcpy(resultPixels, imgResult->data, totalBytes);
        AndroidBitmap_unlockPixels(env, resultBitmap);
    } else {
        LOGE("nativeRemoveText: failed to lock result bitmap pixels");
        ocr_free_image_result(imgResult);
        return nullptr;
    }

    ocr_free_image_result(imgResult);

    LOGI("nativeRemoveText: inpainting complete (%dx%d)",
         imgResult->width, imgResult->height);
    return resultBitmap;
}

/**
 * @brief Replace text in a specific region with new text content.
 *
 * @param env     JNI environment.
 * @param thiz    The calling Java/Kotlin object (unused).
 * @param handle  Native engine handle.
 * @param bitmap  Source bitmap (RGBA_8888).
 * @param bbox    A `float[4]` describing the target region `[x, y, w, h]`.
 * @param newText The replacement text to render into the region.
 * @return A new `Bitmap` with the text replaced, or `null` on failure.
 */
JNIEXPORT jobject JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeReplaceText(JNIEnv* env,
                                                       jobject thiz,
                                                       jlong handle,
                                                       jobject bitmap,
                                                       jfloatArray bbox,
                                                       jstring newText) {
    if (handle == 0) {
        LOGE("nativeReplaceText: engine handle is null");
        return nullptr;
    }

    int width  = 0;
    int height = 0;
    std::vector<uint8_t> pixels = getBitmapPixels(env, bitmap, &width, &height);
    if (pixels.empty()) {
        LOGE("nativeReplaceText: failed to extract bitmap pixels");
        return nullptr;
    }

    // Read bbox float[4]
    jsize arrayLen = env->GetArrayLength(bbox);
    if (arrayLen < 4) {
        LOGE("nativeReplaceText: bbox array must have at least 4 elements");
        return nullptr;
    }
    std::vector<float> bboxData(4);
    env->GetFloatArrayRegion(bbox, 0, 4, bboxData.data());

    // Convert to OCRBBox using our helper
    OCRBBox cBBox = ocr_bbox_from_rect(bboxData[0], bboxData[1], bboxData[2], bboxData[3]);

    // Get text
    const char* newTextCStr = env->GetStringUTFChars(newText, nullptr);
    if (newTextCStr == nullptr) {
        LOGE("nativeReplaceText: newText is null");
        return nullptr;
    }

    auto* engine = reinterpret_cast<OCRHandle*>(handle);

    // Call C API (with NULL for font_config_json to auto font match)
    OCRImageResult* imgResult = ocr_replace_text(engine,
                                                 pixels.data(),
                                                 width,
                                                 height,
                                                 /*channels=*/4,
                                                 &cBBox,
                                                 newTextCStr,
                                                 /*font_config_json=*/nullptr);
    env->ReleaseStringUTFChars(newText, newTextCStr);

    if (imgResult == nullptr) {
        LOGE("nativeReplaceText: ocr_replace_text returned null");
        return nullptr;
    }

    // Create a new Android Bitmap from the result pixels.
    jclass bitmapClass  = env->FindClass("android/graphics/Bitmap");
    jmethodID createBmp = env->GetStaticMethodID(
        bitmapClass,
        "createBitmap",
        "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;");

    jclass configClass   = env->FindClass("android/graphics/Bitmap$Config");
    jfieldID argb8888    = env->GetStaticFieldID(configClass, "ARGB_8888",
                                                   "Landroid/graphics/Bitmap$Config;");
    jobject configObj    = env->GetStaticObjectField(configClass, argb8888);

    jobject resultBitmap = env->CallStaticObjectMethod(bitmapClass,
                                                       createBmp,
                                                       imgResult->width,
                                                       imgResult->height,
                                                       configObj);

    // Copy pixels into the new bitmap.
    void* resultPixels = nullptr;
    if (AndroidBitmap_lockPixels(env, resultBitmap, &resultPixels) == ANDROID_BITMAP_RESULT_SUCCESS) {
        const size_t totalBytes =
            static_cast<size_t>(imgResult->width) * imgResult->height * 4u;
        std::memcpy(resultPixels, imgResult->data, totalBytes);
        AndroidBitmap_unlockPixels(env, resultBitmap);
    } else {
        LOGE("nativeReplaceText: failed to lock result bitmap pixels");
        ocr_free_image_result(imgResult);
        return nullptr;
    }

    ocr_free_image_result(imgResult);

    LOGI("nativeReplaceText: replacement complete (%dx%d)",
         imgResult->width, imgResult->height);
    return resultBitmap;
}

JNIEXPORT jstring JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeParsePptx(JNIEnv* env,
                                                    jobject thiz,
                                                    jlong engineHandle,
                                                    jstring pptxPath) {
    OCRHandle* handle = reinterpret_cast<OCRHandle*>(engineHandle);
    if (handle == nullptr) {
        LOGE("nativeParsePptx: invalid engine handle");
        return nullptr;
    }

    const char* path = env->GetStringUTFChars(pptxPath, nullptr);
    const char* jsonResult = ocr_parse_pptx(handle, path);
    env->ReleaseStringUTFChars(pptxPath, path);

    if (jsonResult == nullptr) {
        LOGE("nativeParsePptx: ocr_parse_pptx returned null");
        return nullptr;
    }

    jstring resultStr = env->NewStringUTF(jsonResult);
    ocr_free_string(jsonResult);
    return resultStr;
}

JNIEXPORT jint JNICALL
Java_com_ocreditor_bridge_OCREngine_nativeCanvasReplaceLayerImage(JNIEnv* env,
                                                                  jobject thiz,
                                                                  jlong engineHandle,
                                                                  jstring layerId,
                                                                  jobject newBitmap) {
    OCRHandle* handle = reinterpret_cast<OCRHandle*>(engineHandle);
    if (handle == nullptr) {
        LOGE("nativeCanvasReplaceLayerImage: invalid engine handle");
        return 0;
    }

    int width = 0;
    int height = 0;
    std::vector<uint8_t> pixels = getBitmapPixels(env, newBitmap, &width, &height);
    if (pixels.empty()) {
        LOGE("nativeCanvasReplaceLayerImage: failed to extract pixels from new bitmap");
        return 0;
    }

    const char* lid = env->GetStringUTFChars(layerId, nullptr);
    int success = ocr_canvas_replace_layer_image(handle, lid, pixels.data(), width, height);
    env->ReleaseStringUTFChars(layerId, lid);

    return success;
}

}  // extern "C"
