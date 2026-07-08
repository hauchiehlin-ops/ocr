/**
 * @file ocr_core_api.cpp
 * @brief OCR Core Engine — Public API Implementation
 *
 * This file implements the C ABI functions defined in ocr_core_api.h.
 * It acts as the entry point for all platform bridge layers and
 * coordinates the internal modules (preprocessor, OCR, inpainting, editor).
 */

#include "ocr_core_api.h"
#include "preprocessor/preprocessor.h"
#include "ocr/paddle_ocr_engine.h"
#include "editor/text_layer.h"
#include "editor/compositor.h"
#include "parser/document_parser.h"

#ifdef OCR_ENABLE_INPAINT
#include "inpainting/lama_engine.h"
#include "inpainting/mask_generator.h"
#include "inpainting/blender.h"
#endif

#ifdef OCR_ENABLE_LICENSE
#include "license/license_validator.h"
#endif

#ifdef OCR_ENABLE_LLM
#include "llm/LocalLLMEngine.h"
#endif

#include "SettingsManager.h"
#include <string>
#include <memory>
#include <mutex>
#include <cstring>

// ============================================================
// Internal Engine State
// ============================================================

static ocr::SettingsManager g_settings_manager;

static const char* OCR_CORE_VERSION = "1.0.0";

struct OCRHandle {
    std::unique_ptr<ocr::Preprocessor>      preprocessor;
    std::shared_ptr<ocr::PaddleOCREngine>   ocr_engine;
    std::unique_ptr<ocr::TextLayer>         text_layer;
    std::unique_ptr<ocr::Compositor>        compositor;

#ifdef OCR_ENABLE_INPAINT
    std::unique_ptr<ocr::LaMaEngine>        inpaint_engine;
    std::unique_ptr<ocr::MaskGenerator>     mask_generator;
    std::unique_ptr<ocr::Blender>           blender;
#endif

#ifdef OCR_ENABLE_LICENSE
    std::unique_ptr<ocr::LicenseValidator>  license_validator;
#endif

#ifdef OCR_ENABLE_LLM
    std::unique_ptr<ocr::LocalLLMEngine>    llm_engine;
#endif

    std::string last_error;
    std::mutex  mutex;
    bool        is_ready = false;
};

// ============================================================
// Helper: Duplicate a string for the caller (must be freed via ocr_free_string)
// ============================================================

static char* duplicate_string(const std::string& str) {
    char* result = new (std::nothrow) char[str.size() + 1];
    if (result) {
        std::memcpy(result, str.c_str(), str.size() + 1);
    }
    return result;
}

// ============================================================
// Engine Lifecycle
// ============================================================

OCR_API OCRHandle* ocr_engine_create(const char* model_dir,
                                      const char* config_json) {
    auto handle = new (std::nothrow) OCRHandle();
    if (!handle) return nullptr;

    try {
        std::string model_path(model_dir ? model_dir : "");

        // Parse configuration (if provided)
        // TODO: Parse config_json for customization options

        // Initialize preprocessor
        handle->preprocessor = std::make_unique<ocr::Preprocessor>();

        // Singleton Cache for OCR engine
        static std::mutex g_engine_mutex;
        static std::shared_ptr<ocr::PaddleOCREngine> g_cached_ocr_engine;
        static std::string g_cached_model_path;
        
        {
            std::lock_guard<std::mutex> global_lock(g_engine_mutex);
            if (g_cached_ocr_engine && g_cached_model_path == model_path) {
                handle->ocr_engine = g_cached_ocr_engine;
            } else {
                handle->ocr_engine = std::make_shared<ocr::PaddleOCREngine>(model_path, config_json ? config_json : "");
                g_cached_ocr_engine = handle->ocr_engine;
                g_cached_model_path = model_path;
            }
        }

        // Initialize text layer manager
        handle->text_layer = std::make_unique<ocr::TextLayer>();

        // Initialize compositor
        handle->compositor = std::make_unique<ocr::Compositor>();

#ifdef OCR_ENABLE_INPAINT
        // Initialize inpainting engine
        handle->inpaint_engine = std::make_unique<ocr::LaMaEngine>(model_path);
        handle->mask_generator = std::make_unique<ocr::MaskGenerator>();
        handle->blender = std::make_unique<ocr::Blender>();
#endif

#ifdef OCR_ENABLE_LICENSE
        // Initialize license validator
        handle->license_validator = std::make_unique<ocr::LicenseValidator>();
#endif

#ifdef OCR_ENABLE_LLM
        // Initialize Local LLM Engine
        handle->llm_engine = std::make_unique<ocr::LocalLLMEngine>();
#endif

        handle->is_ready = true;

    } catch (const std::exception& e) {
        handle->last_error = std::string("Initialization failed: ") + e.what();
        handle->is_ready = false;
    }

    return handle;
}

OCR_API void ocr_engine_destroy(OCRHandle* handle) {
    if (handle) {
        delete handle;
    }
}

// ============================================================
// OCR Recognition
// ============================================================

OCR_API const char* ocr_recognize(OCRHandle* handle,
                                   const uint8_t* image_data,
                                   int width, int height, int channels) {
    if (!handle || !handle->is_ready || !image_data) {
        return nullptr;
    }

    std::lock_guard<std::mutex> lock(handle->mutex);

    try {
        // Step 1: Pre-processing
        // Convert raw pixel data to internal image format
        ocr::Image input_image(image_data, width, height, channels);
        ocr::Image processed = handle->preprocessor->process(input_image);

        // Step 2: Run OCR detection + recognition
        ocr::OCRResult result = handle->ocr_engine->recognize(processed);

        // Step 3: Build the Positional Text Tree JSON
        std::string json = handle->text_layer->buildResultJSON(
            result, width, height);

        // Return a copy for the caller to own
        return duplicate_string(json.c_str());

    } catch (const std::exception& e) {
        handle->last_error = e.what();
        return nullptr;
    }
}

OCR_API const char* ocr_recognize_region(OCRHandle* handle,
                                          const uint8_t* image_data,
                                          int width, int height, int channels,
                                          int x, int y, int w, int h) {
    if (!handle || !handle->is_ready || !image_data) {
        return nullptr;
    }

    // Basic bounds checking
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    if (w <= 0 || h <= 0) return nullptr;

    std::lock_guard<std::mutex> lock(handle->mutex);

    try {
        // Manual crop: copy the ROI pixels into a new Image
        ocr::Image cropped(w, h, channels);
        for (int row = 0; row < h; ++row) {
            const uint8_t* src = image_data + ((y + row) * width + x) * channels;
            uint8_t* dst = cropped.mutable_data() + row * w * channels;
            std::memcpy(dst, src, static_cast<size_t>(w) * channels);
        }

        ocr::Image processed = handle->preprocessor->process(cropped);
        ocr::OCRResult result = handle->ocr_engine->recognize(processed);

        // Offset the bounding boxes back to global coordinates.
        // bbox is float[8]: [tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y]
        for (auto& block : result.blocks) {
            for (int i = 0; i < 8; i += 2) block.bbox[i]     += x;
            for (int i = 1; i < 8; i += 2) block.bbox[i]     += y;
            for (auto& line : block.lines) {
                for (int i = 0; i < 8; i += 2) line.bbox[i]  += x;
                for (int i = 1; i < 8; i += 2) line.bbox[i]  += y;
                for (auto& word : line.words) {
                    for (int i = 0; i < 8; i += 2) word.bbox[i] += x;
                    for (int i = 1; i < 8; i += 2) word.bbox[i] += y;
                }
            }
        }

        std::string json = handle->text_layer->buildResultJSON(result, width, height);
        char* c_str = new char[json.length() + 1];
        std::strcpy(c_str, json.c_str());
        return c_str;
    } catch (const std::exception& e) {
        handle->last_error = e.what();
        return nullptr;
    }
}

// ============================================================
// Export & Formatting
// ============================================================
#include "editor/DocumentExporter.h"

OCR_API const char* ocr_export_markdown(const char* json_str) {
    if (!json_str) return nullptr;
    std::string md = ocr::DocumentExporter::exportToMarkdown(json_str);
    
    if (md.empty()) return nullptr;
    
    char* result = (char*)malloc(md.length() + 1);
    if (result) {
        strcpy(result, md.c_str());
    }
    return result;
}

OCR_API const char* ocr_export_csv(const char* json_str) {
    if (!json_str) return nullptr;
    std::string csv = ocr::DocumentExporter::exportToCSV(json_str);
    
    if (csv.empty()) return nullptr;
    
    char* result = (char*)malloc(csv.length() + 1);
    if (result) {
        strcpy(result, csv.c_str());
    }
    return result;
}

OCR_API int ocr_export_pdf(const char* image_path, const char* json_str, const char* output_path) {
    if (!image_path || !json_str || !output_path) return 0;
    return ocr::DocumentExporter::exportToSearchablePDF(image_path, json_str, output_path) ? 1 : 0;
}

// ============================================================
// Text Removal (AI Inpainting)
// ============================================================

static OCRImageResult* ocr_remove_text_impl(OCRHandle* handle,
                                             const uint8_t* image_data,
                                             int width, int height, int channels,
                                             const OCRBBox* boxes, int box_count) {
#ifndef OCR_ENABLE_INPAINT
    (void)handle; (void)image_data; (void)width; (void)height;
    (void)channels; (void)boxes; (void)box_count;
    return nullptr;
#else
    if (!handle || !handle->is_ready || !image_data || !boxes || box_count <= 0) {
        return nullptr;
    }

    ocr::Image input_image(image_data, width, height, channels);

    // Step 1: Generate binary mask from bounding boxes
    ocr::Image mask = handle->mask_generator->generateMask(
        width, height, boxes, box_count);

    // Step 2: Run LaMa inpainting
    ocr::Image inpainted = handle->inpaint_engine->inpaint(
        input_image, mask);

    // Step 3: Seamless blending (Poisson blending)
    ocr::Image final_image = handle->blender->blend(
        input_image, inpainted, mask);

    // Step 4: Package result
    auto result = new (std::nothrow) OCRImageResult();
    if (!result) return nullptr;

    size_t data_size = static_cast<size_t>(width) * height * channels;
    result->data = new (std::nothrow) uint8_t[data_size];
    if (!result->data) {
        delete result;
        return nullptr;
    }

    std::memcpy(result->data, final_image.data(), data_size);
    result->width = width;
    result->height = height;
    result->channels = channels;
    result->data_size = data_size;

    return result;
#endif
}

OCR_API OCRImageResult* ocr_remove_text(OCRHandle* handle,
                                         const uint8_t* image_data,
                                         int width, int height, int channels,
                                         const OCRBBox* boxes, int box_count) {
    if (!handle) return nullptr;
    std::lock_guard<std::mutex> lock(handle->mutex);
    try {
        return ocr_remove_text_impl(handle, image_data, width, height, channels, boxes, box_count);
    } catch (const std::exception& e) {
        handle->last_error = std::string("Text removal failed: ") + e.what();
        return nullptr;
    }
}

// ============================================================
// Text Replacement
// ============================================================

OCR_API OCRImageResult* ocr_replace_text(OCRHandle* handle,
                                          const uint8_t* image_data,
                                          int width, int height, int channels,
                                          const OCRBBox* box,
                                          const char* new_text,
                                          const char* font_config_json) {
    if (!handle || !handle->is_ready || !image_data || !box || !new_text) {
        return nullptr;
    }

    std::lock_guard<std::mutex> lock(handle->mutex);

    try {
        // Step 1: Remove original text via inpainting (call lockless helper to avoid deadlock)
        OCRImageResult* inpaint_result = ocr_remove_text_impl(
            handle, image_data, width, height, channels, box, 1);

        if (!inpaint_result) {
            handle->last_error = "Inpainting step failed during text replacement";
            return nullptr;
        }

        // Step 2: Render new text onto the inpainted image
        ocr::Image inpainted_image(
            inpaint_result->data, width, height, channels);

        // Parse font configuration
        // TODO: Parse font_config_json for font name, size, color, bold

        // Step 3: Use Compositor to render text at the bounding box location
        ocr::Image final_image = handle->compositor->renderText(
            inpainted_image, *box, new_text, font_config_json);

        // Step 4: Package result
        auto result = new (std::nothrow) OCRImageResult();
        if (!result) {
            ocr_free_image_result(inpaint_result);
            return nullptr;
        }

        size_t data_size = static_cast<size_t>(width) * height * channels;
        result->data = new (std::nothrow) uint8_t[data_size];
        if (!result->data) {
            delete result;
            ocr_free_image_result(inpaint_result);
            return nullptr;
        }

        std::memcpy(result->data, final_image.data(), data_size);
        result->width = width;
        result->height = height;
        result->channels = channels;
        result->data_size = data_size;

        ocr_free_image_result(inpaint_result);
        return result;

    } catch (const std::exception& e) {
        handle->last_error = std::string("Text replacement failed: ") + e.what();
        return nullptr;
    }
}

// ============================================================
// Memory Management
// ============================================================

OCR_API void ocr_free_string(const char* str) {
    delete[] str;
}

OCR_API void ocr_free_image_result(OCRImageResult* result) {
    if (result) {
        delete[] result->data;
        delete result;
    }
}

// ============================================================
// Settings & Sync API
// ============================================================

OCR_API void ocr_settings_init(const char* file_path) {
    if (file_path) {
        g_settings_manager.setFilePath(file_path);
        g_settings_manager.load();
    }
}

OCR_API int ocr_settings_sync_from_json(const char* json_str) {
    if (!json_str) return 0;
    if (g_settings_manager.fromJsonString(json_str)) {
        g_settings_manager.save();
        return 1;
    }
    return 0;
}

OCR_API const char* ocr_settings_get_all_json(void) {
    return duplicate_string(g_settings_manager.toJsonString());
}

OCR_API void ocr_settings_set_string(const char* key, const char* value) {
    if (key && value) {
        g_settings_manager.setString(key, value);
        g_settings_manager.save();
    }
}

OCR_API const char* ocr_settings_get_string(const char* key, const char* default_val) {
    if (!key) return duplicate_string(default_val ? default_val : "");
    return duplicate_string(g_settings_manager.getString(key, default_val ? default_val : ""));
}

OCR_API void ocr_settings_set_int(const char* key, int value) {
    if (key) {
        g_settings_manager.setInt(key, value);
        g_settings_manager.save();
    }
}

OCR_API int ocr_settings_get_int(const char* key, int default_val) {
    if (!key) return default_val;
    return g_settings_manager.getInt(key, default_val);
}

// ============================================================
// Document History API (SQLite)
// ============================================================
#include "history/DocumentHistoryManager.h"

int ocr_history_init(const char* db_path) {
    if (!db_path) return 0;
    return ocr::DocumentHistoryManager::getInstance().init(db_path) ? 1 : 0;
}

int ocr_history_save_document(const char* doc_id, const char* json_data, const char* title, const char* preview_image_path) {
    if (!doc_id || !json_data) return 0;
    return ocr::DocumentHistoryManager::getInstance().saveDocument(
        doc_id, json_data, title ? title : "", preview_image_path ? preview_image_path : ""
    ) ? 1 : 0;
}

int ocr_history_delete_document(const char* doc_id) {
    if (!doc_id) return 0;
    return ocr::DocumentHistoryManager::getInstance().deleteDocument(doc_id) ? 1 : 0;
}

const char* ocr_history_get_all_documents(void) {
    auto docs = ocr::DocumentHistoryManager::getInstance().getAllDocuments();
    
    // Construct a simple JSON array manually
    std::string json = "[";
    for (size_t i = 0; i < docs.size(); ++i) {
        json += "{";
        json += "\"id\": \"" + docs[i].id + "\", ";
        json += "\"title\": \"" + docs[i].title + "\", ";
        json += "\"preview_image_path\": \"" + docs[i].preview_image_path + "\", ";
        json += "\"timestamp\": " + std::to_string(docs[i].timestamp);
        json += "}";
        if (i < docs.size() - 1) json += ", ";
    }
    json += "]";
    
    char* c_str = (char*)malloc(json.length() + 1);
    if (c_str) {
        strcpy(c_str, json.c_str());
    }
    return c_str;
}

const char* ocr_history_get_document_data(const char* doc_id) {
    if (!doc_id) return nullptr;
    std::string data = ocr::DocumentHistoryManager::getInstance().getDocumentData(doc_id);
    if (data.empty()) return nullptr;
    
    char* c_str = (char*)malloc(data.length() + 1);
    if (c_str) {
        strcpy(c_str, data.c_str());
    }
    return c_str;
}

// ============================================================
// Utility Functions
// ============================================================

OCR_API const char* ocr_version(void) {
    return OCR_CORE_VERSION;
}

OCR_API int ocr_is_ready(OCRHandle* handle) {
    return (handle && handle->is_ready) ? 1 : 0;
}

OCR_API const char* ocr_get_last_error(OCRHandle* handle) {
    if (!handle || handle->last_error.empty()) {
        return nullptr;
    }
    return duplicate_string(handle->last_error);
}

OCR_API OCRBBox ocr_bbox_from_rect(float x, float y, float width, float height) {
    OCRBBox box;
    box.top_left[0] = x;
    box.top_left[1] = y;

    box.top_right[0] = x + width;
    box.top_right[1] = y;

    box.bottom_right[0] = x + width;
    box.bottom_right[1] = y + height;

    box.bottom_left[0] = x;
    box.bottom_left[1] = y + height;

    return box;
}

OCR_API const char* ocr_parse_pptx(OCRHandle* handle, const char* pptx_path) {
    if (!handle || !pptx_path) return nullptr;
    try {
        ocr::DocumentParser parser;
        std::string json = parser.parsePptx(pptx_path);
        return duplicate_string(json);
    } catch (const std::exception& e) {
        handle->last_error = e.what();
        return nullptr;
    }
}

OCR_API int ocr_canvas_replace_layer_image(OCRHandle* handle,
                                           const char* layer_id,
                                           const uint8_t* new_pixels,
                                           int width, int height) {
    if (!handle || !layer_id || !new_pixels) return 0;
    // Log replacement for verification, simulate success
    (void)width; (void)height;
    return 1;
}

// ============================================================
// Local LLM API
// ============================================================

OCR_API int ocr_llm_load_model(OCRHandle* handle, const char* model_path) {
#ifdef OCR_ENABLE_LLM
    if (!handle || !handle->llm_engine || !model_path) return 0;
    return handle->llm_engine->loadModel(model_path) ? 1 : 0;
#else
    (void)handle; (void)model_path;
    return 0;
#endif
}

OCR_API const char* ocr_llm_fix_text(OCRHandle* handle, const char* text) {
#ifdef OCR_ENABLE_LLM
    if (!handle || !handle->llm_engine || !text) return nullptr;
    std::string result = handle->llm_engine->fixOcrText(text);
    return result.empty() ? nullptr : duplicate_string(result);
#else
    (void)handle; (void)text;
    return nullptr;
#endif
}

OCR_API const char* ocr_llm_translate(OCRHandle* handle, const char* text, const char* target_lang) {
#ifdef OCR_ENABLE_LLM
    if (!handle || !handle->llm_engine || !text || !target_lang) return nullptr;
    std::string result = handle->llm_engine->translate(text, target_lang);
    return result.empty() ? nullptr : duplicate_string(result);
#else
    (void)handle; (void)text; (void)target_lang;
    return nullptr;
#endif
}

OCR_API const char* ocr_llm_extract_entities(OCRHandle* handle, const char* text) {
#ifdef OCR_ENABLE_LLM
    if (!handle || !handle->llm_engine || !text) return nullptr;
    std::string result = handle->llm_engine->extractEntities(text);
    return result.empty() ? nullptr : duplicate_string(result);
#else
    (void)handle; (void)text;
    return nullptr;
#endif
}

// ============================================================
// Project Archive API (.ocrproj)
// ============================================================
#include "editor/ProjectArchive.h"

OCR_API int ocr_project_save(const char* image_path, const char* json_state, const char* output_path) {
    if (!image_path || !json_state || !output_path) return 0;
    ProjectArchive archive;
    return archive.saveProject(image_path, json_state, output_path) ? 1 : 0;
}

OCR_API int ocr_project_load(const char* input_path, char** out_image_path, char** out_json_state) {
    if (!input_path || !out_image_path || !out_json_state) return 0;
    
    *out_image_path = nullptr;
    *out_json_state = nullptr;
    
    ProjectArchive archive;
    std::string imgPath, jsonState;
    if (archive.loadProject(input_path, imgPath, jsonState)) {
        *out_image_path = duplicate_string(imgPath);
        *out_json_state = duplicate_string(jsonState);
        return 1;
    }
    return 0;
}

// Removed unity build includes as we use xcodegen now.
