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
// Inpainting & Image Processing API
// ============================================================

static jobject createBitmapFromResult(JNIEnv *env, OCRImageResult* result) {
    if (!result) return nullptr;
    
    jclass bitmapClass = env->FindClass("android/graphics/Bitmap");
    jmethodID createBitmapMethodID = env->GetStaticMethodID(bitmapClass, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;");
    
    jclass configClass = env->FindClass("android/graphics/Bitmap$Config");
    jfieldID argb8888FieldID = env->GetStaticFieldID(configClass, "ARGB_8888", "Landroid/graphics/Bitmap$Config;");
    jobject argb8888Obj = env->GetStaticObjectField(configClass, argb8888FieldID);
    
    jobject newBitmap = env->CallStaticObjectMethod(bitmapClass, createBitmapMethodID, result->width, result->height, argb8888Obj);
    if (!newBitmap) {
        LOGE("Failed to create result Bitmap.");
        return nullptr;
    }
    
    void *newPixels;
    if (AndroidBitmap_lockPixels(env, newBitmap, &newPixels) < 0) {
        LOGE("Failed to lock new bitmap pixels.");
        return nullptr;
    }
    
    memcpy(newPixels, result->data, result->data_size);
    AndroidBitmap_unlockPixels(env, newBitmap);
    
    return newBitmap;
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_removeText(JNIEnv *env, jobject /* this */, jobject bitmap, jint x, jint y, jint w, jint h) {
    if (!g_ocrEngine) {
        LOGE("Engine not initialized.");
        return nullptr;
    }

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) < 0 || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("Failed to get bitmap info or format not RGBA_8888.");
        return nullptr;
    }

    void *pixels;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0) {
        LOGE("Failed to lock bitmap pixels.");
        return nullptr;
    }

    OCRBBox box;
    box.top_left[0] = x;           box.top_left[1] = y;
    box.top_right[0] = x + w;      box.top_right[1] = y;
    box.bottom_right[0] = x + w;   box.bottom_right[1] = y + h;
    box.bottom_left[0] = x;        box.bottom_left[1] = y + h;

    OCRImageResult* result = ocr_remove_text(g_ocrEngine, static_cast<const uint8_t*>(pixels), info.width, info.height, 4, &box, 1);
    
    AndroidBitmap_unlockPixels(env, bitmap);
    
    jobject newBitmap = createBitmapFromResult(env, result);
    if (result) ocr_free_image_result(result);
    return newBitmap;
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_replaceText(JNIEnv *env, jobject /* this */, jobject bitmap, jint x, jint y, jint w, jint h, jstring newText, jstring fontConfigJson) {
    if (!g_ocrEngine || !newText) {
        LOGE("Engine not initialized or text is null.");
        return nullptr;
    }

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) < 0 || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("Failed to get bitmap info or format not RGBA_8888.");
        return nullptr;
    }

    void *pixels;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0) {
        LOGE("Failed to lock bitmap pixels.");
        return nullptr;
    }

    OCRBBox box;
    box.top_left[0] = x;           box.top_left[1] = y;
    box.top_right[0] = x + w;      box.top_right[1] = y;
    box.bottom_right[0] = x + w;   box.bottom_right[1] = y + h;
    box.bottom_left[0] = x;        box.bottom_left[1] = y + h;

    const char* cNewText = env->GetStringUTFChars(newText, nullptr);
    const char* cFontConfig = fontConfigJson ? env->GetStringUTFChars(fontConfigJson, nullptr) : nullptr;

    OCRImageResult* result = ocr_replace_text(g_ocrEngine, static_cast<const uint8_t*>(pixels), info.width, info.height, 4, &box, cNewText, cFontConfig);
    
    env->ReleaseStringUTFChars(newText, cNewText);
    if (fontConfigJson) env->ReleaseStringUTFChars(fontConfigJson, cFontConfig);
    
    AndroidBitmap_unlockPixels(env, bitmap);
    
    jobject newBitmap = createBitmapFromResult(env, result);
    if (result) ocr_free_image_result(result);
    return newBitmap;
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

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_exportCSVFromJson(JNIEnv *env, jobject /* this */, jstring jsonString) {
    if (jsonString) {
        const char *json = env->GetStringUTFChars(jsonString, nullptr);
        const char *cCsv = ocr_export_csv(json);
        env->ReleaseStringUTFChars(jsonString, json);
        
        if (cCsv) {
            jstring result = env->NewStringUTF(cCsv);
            ocr_free_string(cCsv);
            return result;
        }
    }
    return nullptr;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_exportPDF(JNIEnv *env, jobject /* this */, jstring imagePath, jstring jsonState, jstring outputPath) {
    if (!imagePath || !jsonState || !outputPath) return JNI_FALSE;
    
    const char *cImagePath = env->GetStringUTFChars(imagePath, nullptr);
    const char *cJsonState = env->GetStringUTFChars(jsonState, nullptr);
    const char *cOutputPath = env->GetStringUTFChars(outputPath, nullptr);
    
    int result = ocr_export_pdf(cImagePath, cJsonState, cOutputPath);
    
    env->ReleaseStringUTFChars(imagePath, cImagePath);
    env->ReleaseStringUTFChars(jsonState, cJsonState);
    env->ReleaseStringUTFChars(outputPath, cOutputPath);
    
    return result != 0 ? JNI_TRUE : JNI_FALSE;
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

// ============================================================
// LLM API
// ============================================================

extern "C" JNIEXPORT jboolean JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_loadLLMModel(JNIEnv *env, jobject /* this */, jstring modelPath) {
    if (!g_ocrEngine) return JNI_FALSE;
    if (modelPath) {
        const char *path = env->GetStringUTFChars(modelPath, nullptr);
        int result = ocr_llm_load_model(g_ocrEngine, path);
        env->ReleaseStringUTFChars(modelPath, path);
        return result != 0 ? JNI_TRUE : JNI_FALSE;
    }
    return JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_fixTextWithLLM(JNIEnv *env, jobject /* this */, jstring text) {
    if (!g_ocrEngine || !text) return nullptr;
    const char *cText = env->GetStringUTFChars(text, nullptr);
    const char *cResult = ocr_llm_fix_text(g_ocrEngine, cText);
    env->ReleaseStringUTFChars(text, cText);
    
    if (cResult) {
        jstring result = env->NewStringUTF(cResult);
        ocr_free_string(cResult);
        return result;
    }
    return nullptr;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_translateWithLLM(JNIEnv *env, jobject /* this */, jstring text, jstring targetLang) {
    if (!g_ocrEngine || !text || !targetLang) return nullptr;
    const char *cText = env->GetStringUTFChars(text, nullptr);
    const char *cLang = env->GetStringUTFChars(targetLang, nullptr);
    const char *cResult = ocr_llm_translate(g_ocrEngine, cText, cLang);
    env->ReleaseStringUTFChars(text, cText);
    env->ReleaseStringUTFChars(targetLang, cLang);
    
    if (cResult) {
        jstring result = env->NewStringUTF(cResult);
        ocr_free_string(cResult);
        return result;
    }
    return nullptr;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_extractEntitiesWithLLM(JNIEnv *env, jobject /* this */, jstring text) {
    if (!g_ocrEngine || !text) return nullptr;
    const char *cText = env->GetStringUTFChars(text, nullptr);
    const char *cResult = ocr_llm_extract_entities(g_ocrEngine, cText);
    env->ReleaseStringUTFChars(text, cText);
    
    if (cResult) {
        jstring result = env->NewStringUTF(cResult);
        ocr_free_string(cResult);
        return result;
    }
    return nullptr;
}

// ============================================================
// Project Archive API (.ocrproj)
// ============================================================

extern "C" JNIEXPORT jboolean JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_saveProjectArchive(JNIEnv *env, jobject /* this */, jstring imagePath, jstring jsonState, jstring outputPath) {
    if (!imagePath || !jsonState || !outputPath) return JNI_FALSE;
    
    const char *cImagePath = env->GetStringUTFChars(imagePath, nullptr);
    const char *cJsonState = env->GetStringUTFChars(jsonState, nullptr);
    const char *cOutputPath = env->GetStringUTFChars(outputPath, nullptr);
    
    int result = ocr_project_save(cImagePath, cJsonState, cOutputPath);
    
    env->ReleaseStringUTFChars(imagePath, cImagePath);
    env->ReleaseStringUTFChars(jsonState, cJsonState);
    env->ReleaseStringUTFChars(outputPath, cOutputPath);
    
    return result != 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_hauchiehlin_ocreditor_OCREngineBridge_loadProjectArchive(JNIEnv *env, jobject /* this */, jstring inputPath) {
    if (!inputPath) return nullptr;
    
    const char *cInputPath = env->GetStringUTFChars(inputPath, nullptr);
    char *outImagePath = nullptr;
    char *outJsonState = nullptr;
    
    int result = ocr_project_load(cInputPath, &outImagePath, &outJsonState);
    env->ReleaseStringUTFChars(inputPath, cInputPath);
    
    if (result != 0 && outImagePath && outJsonState) {
        jobjectArray ret = env->NewObjectArray(2, env->FindClass("java/lang/String"), env->NewStringUTF(""));
        env->SetObjectArrayElement(ret, 0, env->NewStringUTF(outImagePath));
        env->SetObjectArrayElement(ret, 1, env->NewStringUTF(outJsonState));
        
        ocr_free_string(outImagePath);
        ocr_free_string(outJsonState);
        return ret;
    }
    
    return nullptr;
}
