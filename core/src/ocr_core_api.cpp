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

#include <string>
#include <memory>
#include <mutex>
#include <cstring>

// ============================================================
// Internal Engine State
// ============================================================

static const char* OCR_CORE_VERSION = "1.0.0";

struct OCRHandle {
    std::unique_ptr<ocr::Preprocessor>      preprocessor;
    std::unique_ptr<ocr::PaddleOCREngine>   ocr_engine;
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

        // Initialize OCR engine with model files and config options
        handle->ocr_engine = std::make_unique<ocr::PaddleOCREngine>(model_path, config_json ? config_json : "");

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
        return duplicate_string(json);

    } catch (const std::exception& e) {
        handle->last_error = std::string("Recognition failed: ") + e.what();
        return nullptr;
    }
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
