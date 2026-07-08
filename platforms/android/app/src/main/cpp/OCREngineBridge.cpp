#include <jni.h>
#include <string>
#include <vector>
#include <android/log.h>
#include <android/bitmap.h>
#include "ocr_core_api.h"

#define LOG_TAG "OCREngineBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static OCRHandle* g_ocrEngine = nullptr;

extern "C" JNIEXPORT jboolean JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_initEngine(JNIEnv *env, jobject /* this */, jstring modelPath, jstring configJson) {
    if (g_ocrEngine) {
        LOGI("Engine already initialized.");
        return JNI_TRUE;
    }
    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    const char *config = configJson ? env->GetStringUTFChars(configJson, nullptr) : nullptr;
    
    LOGI("Initializing engine with path: %s", path);
    g_ocrEngine = ocr_engine_create(path, config);
    
    env->ReleaseStringUTFChars(modelPath, path);
    if (configJson) env->ReleaseStringUTFChars(configJson, config);
    
    return g_ocrEngine != nullptr ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_recognizeText(JNIEnv *env, jobject /* this */, jobject bitmap) {
    if (!g_ocrEngine) {
        LOGE("Engine not initialized.");
        return env->NewStringUTF("{}");
    }

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) < 0) {
        LOGE("Failed to get bitmap info.");
        return env->NewStringUTF("{}");
    }

    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("Bitmap format is not RGBA_8888.");
        return env->NewStringUTF("{}");
    }

    void *pixels;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0) {
        LOGE("Failed to lock bitmap pixels.");
        return env->NewStringUTF("{}");
    }

    LOGI("Processing image: %d x %d", info.width, info.height);

    // Call OCR engine C API
    const char* jsonResult = ocr_recognize(g_ocrEngine, static_cast<const uint8_t*>(pixels), info.width, info.height, 4);
    
    AndroidBitmap_unlockPixels(env, bitmap);
    
    if (jsonResult) {
        jstring resultString = env->NewStringUTF(jsonResult);
        ocr_free_string(jsonResult);
        return resultString;
    } else {
        return env->NewStringUTF("{}");
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_recognizeRegion(JNIEnv *env, jobject /* this */, jobject bitmap, jint x, jint y, jint w, jint h) {
    if (!g_ocrEngine) {
        LOGE("Engine not initialized.");
        return env->NewStringUTF("{}");
    }

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) < 0) {
        LOGE("Failed to get bitmap info.");
        return env->NewStringUTF("{}");
    }

    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("Bitmap format is not RGBA_8888.");
        return env->NewStringUTF("{}");
    }

    void *pixels;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0) {
        LOGE("Failed to lock bitmap pixels.");
        return env->NewStringUTF("{}");
    }

    // Call OCR engine C API
    const char* jsonResult = ocr_recognize_region(g_ocrEngine, static_cast<const uint8_t*>(pixels), info.width, info.height, 4, x, y, w, h);
    
    AndroidBitmap_unlockPixels(env, bitmap);
    
    if (jsonResult) {
        jstring resultString = env->NewStringUTF(jsonResult);
        ocr_free_string(jsonResult);
        return resultString;
    } else {
        return env->NewStringUTF("{}");
    }
}

// ============================================================
// Export & Formatting API
// ============================================================
extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_exportMarkdownFromJson(JNIEnv *env, jobject /* this */, jstring jsonString) {
    if (jsonString) {
        const char *json = env->GetStringUTFChars(jsonString, nullptr);
        const char *cMarkdown = ocr_export_markdown(json);
        env->ReleaseStringUTFChars(jsonString, json);
        
        if (cMarkdown) {
            jstring result = env->NewStringUTF(cMarkdown);
            ocr_free_string(cMarkdown);
            return result;
        }
    }
    return env->NewStringUTF("");
}

// ============================================================
// History API
// ============================================================

extern "C" JNIEXPORT void JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_initHistory(JNIEnv *env, jobject /* this */, jstring dbPath) {
    if (dbPath) {
        const char *path = env->GetStringUTFChars(dbPath, nullptr);
        ocr_history_init(path);
        env->ReleaseStringUTFChars(dbPath, path);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_saveHistoryDocument(JNIEnv *env, jobject /* this */, jstring docId, jstring jsonData, jstring title, jstring previewImagePath) {
    if (docId && jsonData && title) {
        const char *cDocId = env->GetStringUTFChars(docId, nullptr);
        const char *cJson = env->GetStringUTFChars(jsonData, nullptr);
        const char *cTitle = env->GetStringUTFChars(title, nullptr);
        const char *cPreview = previewImagePath ? env->GetStringUTFChars(previewImagePath, nullptr) : "";
        
        ocr_history_save_document(cDocId, cJson, cTitle, cPreview);
        
        env->ReleaseStringUTFChars(docId, cDocId);
        env->ReleaseStringUTFChars(jsonData, cJson);
        env->ReleaseStringUTFChars(title, cTitle);
        if (previewImagePath) env->ReleaseStringUTFChars(previewImagePath, cPreview);
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_getAllHistoryJson(JNIEnv *env, jobject /* this */) {
    const char *cJson = ocr_history_get_all_documents();
    if (cJson) {
        jstring result = env->NewStringUTF(cJson);
        ocr_free_string(cJson);
        return result;
    }
    return env->NewStringUTF("[]");
}

// ============================================================
// Settings & Sync API
// ============================================================

extern "C" JNIEXPORT void JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_initSettings(JNIEnv *env, jobject /* this */, jstring filePath) {
    if (filePath) {
        const char *path = env->GetStringUTFChars(filePath, nullptr);
        ocr_settings_init(path);
        env->ReleaseStringUTFChars(filePath, path);
    }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_syncSettingsFromJson(JNIEnv *env, jobject /* this */, jstring jsonString) {
    if (jsonString) {
        const char *json = env->GetStringUTFChars(jsonString, nullptr);
        int result = ocr_settings_sync_from_json(json);
        env->ReleaseStringUTFChars(jsonString, json);
        return result != 0 ? JNI_TRUE : JNI_FALSE;
    }
    return JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_getAllSettingsJson(JNIEnv *env, jobject /* this */) {
    const char *cJson = ocr_settings_get_all_json();
    if (cJson) {
        jstring result = env->NewStringUTF(cJson);
        ocr_free_string(cJson);
        return result;
    }
    return env->NewStringUTF("{}");
}

extern "C" JNIEXPORT void JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_setStringSetting(JNIEnv *env, jobject /* this */, jstring key, jstring value) {
    if (key && value) {
        const char *cKey = env->GetStringUTFChars(key, nullptr);
        const char *cValue = env->GetStringUTFChars(value, nullptr);
        ocr_settings_set_string(cKey, cValue);
        env->ReleaseStringUTFChars(key, cKey);
        env->ReleaseStringUTFChars(value, cValue);
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_getStringSetting(JNIEnv *env, jobject /* this */, jstring key, jstring defaultValue) {
    if (key) {
        const char *cKey = env->GetStringUTFChars(key, nullptr);
        const char *cDefault = defaultValue ? env->GetStringUTFChars(defaultValue, nullptr) : "";
        
        const char *cValue = ocr_settings_get_string(cKey, cDefault);
        
        env->ReleaseStringUTFChars(key, cKey);
        if (defaultValue) {
            env->ReleaseStringUTFChars(defaultValue, cDefault);
        }
        
        if (cValue) {
            jstring result = env->NewStringUTF(cValue);
            ocr_free_string(cValue);
            return result;
        }
    }
    return defaultValue ? defaultValue : env->NewStringUTF("");
}

extern "C" JNIEXPORT void JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_setIntSetting(JNIEnv *env, jobject /* this */, jstring key, jint value) {
    if (key) {
        const char *cKey = env->GetStringUTFChars(key, nullptr);
        ocr_settings_set_int(cKey, value);
        env->ReleaseStringUTFChars(key, cKey);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_getIntSetting(JNIEnv *env, jobject /* this */, jstring key, jint defaultValue) {
    if (key) {
        const char *cKey = env->GetStringUTFChars(key, nullptr);
        int result = ocr_settings_get_int(cKey, defaultValue);
        env->ReleaseStringUTFChars(key, cKey);
        return result;
    }
    return defaultValue;
}
