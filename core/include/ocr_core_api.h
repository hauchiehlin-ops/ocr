/**
 * @file ocr_core_api.h
 * @brief OCR Core Engine — Public C ABI Interface
 *
 * This header defines the unified C API for the OCR Core Engine.
 * All platforms (iOS, Android, macOS, Windows) use this same interface
 * through their respective bridge layers:
 *   - iOS/macOS:  Objective-C++ (.mm files)
 *   - Android:    JNI (Java Native Interface)
 *   - Windows:    P/Invoke (.NET DLL Import)
 *
 * The C ABI ensures maximum compatibility and simplicity across all
 * foreign function interface (FFI) mechanisms.
 *
 * @note All functions are thread-safe unless otherwise noted.
 * @note Memory management: The caller must free returned strings/images
 *       using the provided ocr_free_* functions.
 *
 * @version 1.0.0
 * @date 2026-07-04
 */

#ifndef OCR_CORE_API_H
#define OCR_CORE_API_H

#include <stdint.h>
#include <stddef.h>

/* ============================================================
 * Platform Export Macros
 * ============================================================ */

#if defined(_WIN32) || defined(_WIN64)
    #ifdef OCR_CORE_EXPORTS
        #define OCR_API __declspec(dllexport)
    #else
        #define OCR_API __declspec(dllimport)
    #endif
#elif defined(__GNUC__) || defined(__clang__)
    #define OCR_API __attribute__((visibility("default")))
#else
    #define OCR_API
#endif



#ifdef __cplusplus
extern "C" {
#endif

// ============================================================
// Settings & Sync API
// ============================================================
// Initializes the global settings manager with a file path
OCR_API void ocr_settings_init(const char* file_path);

// Sync settings from JSON string (e.g. pulled from iCloud/Google Drive)
OCR_API int ocr_settings_sync_from_json(const char* json_str);

// Get the current settings as a JSON string (for backing up to cloud)
OCR_API const char* ocr_settings_get_all_json(void);

// Set/Get individual string setting
OCR_API void ocr_settings_set_string(const char* key, const char* value);
OCR_API const char* ocr_settings_get_string(const char* key, const char* default_val);

// Set/Get individual int setting
OCR_API void ocr_settings_set_int(const char* key, int value);
OCR_API int ocr_settings_get_int(const char* key, int default_val);

// ============================================================
// Document History API (SQLite)
// ============================================================
// Initialize the history database at the given file path (e.g. app documents directory)
OCR_API int ocr_history_init(const char* db_path);

// Save or update a document in history
// @param doc_id Unique identifier for the document (UUID)
// @param json_data The OCR result JSON string
// @param title Optional title for the document
// @param preview_image_path Optional path to a saved thumbnail
OCR_API int ocr_history_save_document(const char* doc_id, const char* json_data, const char* title, const char* preview_image_path);

// Delete a document from history
OCR_API int ocr_history_delete_document(const char* doc_id);

// Get a list of all documents in history (returns a JSON array string)
// Format: [{"id": "...", "title": "...", "timestamp": 123456789, "preview": "..."}, ...]
OCR_API const char* ocr_history_get_all_documents(void);

// Get the OCR result JSON data for a specific document
OCR_API const char* ocr_history_get_document_data(const char* doc_id);

/* ============================================================
 * Opaque Handle Types
 * ============================================================ */

/**
 * @brief Opaque handle to an OCR engine instance.
 *
 * Created via ocr_engine_create(), destroyed via ocr_engine_destroy().
 * Each handle maintains its own loaded models and internal state.
 */
typedef struct OCRHandle OCRHandle;

/* ============================================================
 * Data Structures
 * ============================================================ */

/**
 * @brief Quadrilateral bounding box for detected text.
 *
 * Supports rotated/skewed text regions with four corner points.
 * Coordinates are in pixels relative to the original image dimensions.
 *
 * Point order:
 *   top_left ──── top_right
 *       │              │
 *   bottom_left ─ bottom_right
 */
typedef struct OCRBBox {
    float top_left[2];      /**< [x, y] of top-left corner */
    float top_right[2];     /**< [x, y] of top-right corner */
    float bottom_right[2];  /**< [x, y] of bottom-right corner */
    float bottom_left[2];   /**< [x, y] of bottom-left corner */
} OCRBBox;

/**
 * @brief Result of an image processing operation (inpainting/replacement).
 *
 * Contains the output image as raw RGBA pixel data.
 * Must be freed via ocr_free_image_result().
 */
typedef struct OCRImageResult {
    uint8_t* data;          /**< RGBA pixel data (row-major, top-to-bottom) */
    int width;              /**< Image width in pixels */
    int height;             /**< Image height in pixels */
    int channels;           /**< Number of channels (always 4 for RGBA) */
    size_t data_size;       /**< Total size of data buffer in bytes */
} OCRImageResult;

/**
 * @brief Engine configuration options.
 *
 * Pass as JSON string to ocr_engine_create() for fine-grained control.
 * All fields are optional; defaults are used if not specified.
 *
 * Example JSON:
 * {
 *   "num_threads": 4,
 *   "use_gpu": false,
 *   "language": "ch",
 *   "det_model": "ppocr_det_v5.onnx",
 *   "rec_model": "ppocr_rec_v5.onnx",
 *   "cls_model": "ppocr_cls_v5.onnx",
 *   "inpaint_model": "lama_inpaint.onnx",
 *   "enable_deskew": true,
 *   "enable_denoise": true,
 *   "confidence_threshold": 0.5
 * }
 */

/* ============================================================
 * Engine Lifecycle
 * ============================================================ */

/**
 * @brief Create a new OCR engine instance.
 *
 * Loads AI models from the specified directory and initializes
 * the inference runtime (ONNX Runtime).
 *
 * @param model_dir   Path to directory containing .onnx model files.
 *                    Must contain at minimum:
 *                    - ppocr_det_v5.onnx (text detection)
 *                    - ppocr_rec_v5.onnx (text recognition)
 * @param config_json Optional JSON string with configuration options.
 *                    Pass NULL to use defaults.
 *
 * @return Opaque handle to the engine, or NULL on failure.
 *
 * @note This function may take 1-3 seconds to complete (model loading).
 *       Call from a background thread to avoid blocking the UI.
 */
OCR_API OCRHandle* ocr_engine_create(const char* model_dir,
                                      const char* config_json);

/**
 * @brief Destroy an OCR engine instance and release all resources.
 *
 * After calling this, the handle is invalid and must not be used.
 *
 * @param handle  Engine handle returned by ocr_engine_create().
 *                Passing NULL is a no-op.
 */
OCR_API void ocr_engine_destroy(OCRHandle* handle);

/* ============================================================
 * OCR Recognition
 * ============================================================ */

/**
 * @brief Perform OCR text recognition on an image.
 *
 * Executes the full pipeline:
 *   1. Pre-processing (deskew, denoise, binarize)
 *   2. Text detection (PaddleOCR det model)
 *   3. Direction classification (PaddleOCR cls model)
 *   4. Text recognition (PaddleOCR rec model)
 *   5. Contextual correction
 *
 * @param handle      Engine handle.
 * @param image_data  Raw pixel data in RGBA format (row-major, top-to-bottom).
 * @param width       Image width in pixels.
 * @param height      Image height in pixels.
 * @param channels    Number of channels (must be 4 for RGBA).
 *
 * @return JSON string containing the Positional Text Tree result.
 *         Caller MUST free this string via ocr_free_string().
 *         Returns NULL on failure.
 *
 * @see The JSON schema for the output is documented in docs/api-reference.md
 *
 * Example output:
 * {
 *   "image_id": "uuid-xxx",
 *   "dimensions": { "width": 1920, "height": 1080 },
 *   "text_blocks": [{
 *     "id": "block_001",
 *     "type": "paragraph",
 *     "confidence": 0.97,
 *     "bounding_box": {
 *       "top_left": [120, 45], "top_right": [850, 48],
 *       "bottom_right": [852, 92], "bottom_left": [118, 89]
 *     },
 *     "lines": [{
 *       "id": "line_001",
 *       "text": "Hello World",
 *       "confidence": 0.98,
 *       "bounding_box": { ... },
 *       "words": [{
 *         "id": "word_001",
 *         "text": "Hello",
 *         "confidence": 0.99,
 *         "bounding_box": { ... },
 *         "font_estimate": {
 *           "size_px": 24,
 *           "color_rgb": [33, 33, 33],
 *           "is_bold": false
 *         }
 *       }]
 *     }]
 *   }]
 * }
 */
OCR_API const char* ocr_recognize(OCRHandle* handle,
                                   const uint8_t* image_data,
                                   int width, int height, int channels);

/**
 * @brief Performs OCR on a specific region of an image.
 * 
 * @param handle  Engine handle.
 * @param image_data Raw pixel data.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param channels Number of color channels (e.g., 3 for RGB, 4 for RGBA).
 * @param x       Top-left X coordinate of the region.
 * @param y       Top-left Y coordinate of the region.
 * @param w       Width of the region.
 * @param h       Height of the region.
 * @return JSON string of the Positional Text Tree for this region.
 *         Caller MUST free this string via ocr_free_string().
 */
OCR_API const char* ocr_recognize_region(OCRHandle* handle,
                                          const uint8_t* image_data,
                                          int width, int height, int channels,
                                          int x, int y, int w, int h);

/* ============================================================
 * Export & Formatting
 * ============================================================ */

/**
 * 匯出辨識結果為 Markdown
 * 
 * @param json_str ocr_recognize 回傳的 JSON 字串
 * @return Markdown 格式的字串 (需使用 ocr_free_string 釋放)，失敗回傳 NULL
 */
OCR_API const char* ocr_export_markdown(const char* json_str);

/**
 * 匯出辨識結果為 CSV (表格結構)
 * 
 * @param json_str ocr_recognize 回傳的 JSON 字串
 * @return CSV 格式的字串 (需使用 ocr_free_string 釋放)，失敗回傳 NULL
 */
OCR_API const char* ocr_export_csv(const char* json_str);

/**
 * 匯出雙層可搜尋 PDF
 * 
 * @param image_path 圖片檔案路徑
 * @param json_str ocr_recognize 回傳的 JSON 字串
 * @param output_path 輸出的 PDF 檔案路徑
 * @return 成功回傳 1，失敗回傳 0
 */
OCR_API int ocr_export_pdf(const char* image_path, const char* json_str, const char* output_path);

/* ============================================================
 * Text Removal (AI Inpainting)
 * ============================================================ */

/**
 * @brief Remove text from an image using AI inpainting.
 *
 * For each specified bounding box:
 *   1. Generates a binary mask from the bounding box
 *   2. Dilates the mask by 2-4px for complete coverage
 *   3. Runs LaMa inpainting to fill the masked region
 *   4. Applies Poisson blending for seamless edges
 *
 * @param handle      Engine handle.
 * @param image_data  Raw RGBA pixel data of the original image.
 * @param width       Image width in pixels.
 * @param height      Image height in pixels.
 * @param channels    Number of channels (must be 4).
 * @param boxes       Array of bounding boxes specifying text regions to remove.
 * @param box_count   Number of bounding boxes in the array.
 *
 * @return OCRImageResult containing the processed image with text removed.
 *         Caller MUST free via ocr_free_image_result().
 *         Returns NULL on failure.
 *
 * @note Requires OCR_ENABLE_INPAINT build option.
 * @note Processing time scales with the number and size of masked regions.
 */
OCR_API OCRImageResult* ocr_remove_text(OCRHandle* handle,
                                         const uint8_t* image_data,
                                         int width, int height, int channels,
                                         const OCRBBox* boxes, int box_count);

/* ============================================================
 * Text Replacement
 * ============================================================ */

/**
 * @brief Replace text in an image at a specified location.
 *
 * Pipeline:
 *   1. Removes original text via inpainting (same as ocr_remove_text)
 *   2. Estimates font properties from the original text
 *   3. Renders new text using Skia at the same bounding box
 *   4. Matches color/style to surrounding context
 *   5. Composites the rendered text onto the inpainted image
 *
 * @param handle          Engine handle.
 * @param image_data      Raw RGBA pixel data of the original image.
 * @param width           Image width in pixels.
 * @param height          Image height in pixels.
 * @param channels        Number of channels (must be 4).
 * @param box             Bounding box of the text region to replace.
 * @param new_text        UTF-8 encoded replacement text string.
 * @param font_config_json Optional JSON with font configuration:
 *                         { "font_name": "Arial", "size_px": 24,
 *                           "color_rgb": [0,0,0], "bold": false }
 *                         Pass NULL for auto font matching.
 *
 * @return OCRImageResult containing the processed image with text replaced.
 *         Caller MUST free via ocr_free_image_result().
 *         Returns NULL on failure.
 */
OCR_API OCRImageResult* ocr_replace_text(OCRHandle* handle,
                                          const uint8_t* image_data,
                                          int width, int height, int channels,
                                          const OCRBBox* box,
                                          const char* new_text,
                                          const char* font_config_json);

/* ============================================================
 * Memory Management
 * ============================================================ */

/**
 * @brief Free a string returned by the OCR engine.
 *
 * @param str  String pointer returned by ocr_recognize() or similar.
 *             Passing NULL is a no-op.
 */
OCR_API void ocr_free_string(const char* str);

/**
 * @brief Free an image result returned by the OCR engine.
 *
 * @param result  Image result pointer returned by ocr_remove_text(),
 *                ocr_replace_text(), or similar.
 *                Passing NULL is a no-op.
 */
OCR_API void ocr_free_image_result(OCRImageResult* result);

/* ============================================================
 * Local LLM API
 * ============================================================ */

/**
 * @brief Initialize the Local LLM engine and load a model.
 * @param handle Engine handle.
 * @param model_path Path to the GGUF model file.
 * @return 1 on success, 0 on failure.
 */
OCR_API int ocr_llm_load_model(OCRHandle* handle, const char* model_path);

/**
 * @brief Fix OCR text using the local LLM.
 * @param handle Engine handle.
 * @param text The broken OCR text.
 * @return Corrected text. Caller MUST free via ocr_free_string().
 */
OCR_API const char* ocr_llm_fix_text(OCRHandle* handle, const char* text);

/**
 * @brief Translate text using the local LLM.
 * @param handle Engine handle.
 * @param text The source text.
 * @param target_lang The target language.
 * @return Translated text. Caller MUST free via ocr_free_string().
 */
OCR_API const char* ocr_llm_translate(OCRHandle* handle, const char* text, const char* target_lang);

/**
 * @brief Extract entities to JSON using the local LLM.
 * @param handle Engine handle.
 * @param text The source document text.
 * @return JSON string of extracted entities. Caller MUST free via ocr_free_string().
 */
OCR_API const char* ocr_llm_extract_entities(OCRHandle* handle, const char* text);

/* ============================================================
 * Document Canvas and Multi-Layer Support
 * ============================================================ */

/**
 * @brief Parse a PPTX file and export its slides and layers as a JSON string.
 *
 * @param handle     Engine handle.
 * @param pptx_path  Path to the PPTX file on local disk.
 * @return JSON string containing the slide layers (images, shapes, text blocks).
 *         Caller MUST free this string via ocr_free_string().
 *         Returns NULL on failure.
 */
OCR_API const char* ocr_parse_pptx(OCRHandle* handle, const char* pptx_path);

/**
 * @brief Replace the image content of a specific image layer.
 *
 * @param handle      Engine handle.
 * @param layer_id    The unique identifier of the target image layer.
 * @param new_pixels  New RGBA pixel data for the replacement image.
 * @param width       New image width.
 * @param height      New image height.
 * @return 1 on success, 0 on failure.
 */
OCR_API int ocr_canvas_replace_layer_image(OCRHandle* handle,
                                           const char* layer_id,
                                           const uint8_t* new_pixels,
                                           int width, int height);

/* ============================================================
 * Project Archive API (.ocrproj)
 * ============================================================ */

/**
 * @brief Save the current OCR project to an .ocrproj file.
 * @param image_path Path to the current working image.
 * @param json_state The complete JSON state of all layers.
 * @param output_path The destination .ocrproj file path.
 * @return 1 on success, 0 on failure.
 */
OCR_API int ocr_project_save(const char* image_path, const char* json_state, const char* output_path);

/**
 * @brief Load an OCR project from an .ocrproj file.
 * @param input_path The source .ocrproj file path.
 * @param out_image_path Will be set to a temporary extracted image path. Caller MUST free via ocr_free_string.
 * @param out_json_state Will be set to the extracted JSON state. Caller MUST free via ocr_free_string.
 * @return 1 on success, 0 on failure.
 */
OCR_API int ocr_project_load(const char* input_path, char** out_image_path, char** out_json_state);

/* ============================================================
 * Utility Functions
 * ============================================================ */

/**
 * @brief Get the OCR Core Engine version string.
 *
 * @return Static version string (e.g., "1.0.0"). Do NOT free this string.
 */
OCR_API const char* ocr_version(void);

/**
 * @brief Check if the engine is ready for processing.
 *
 * @param handle  Engine handle.
 * @return 1 if the engine is initialized and models are loaded, 0 otherwise.
 */
OCR_API int ocr_is_ready(OCRHandle* handle);

/**
 * @brief Get the last error message from the engine.
 *
 * @param handle  Engine handle.
 * @return Error message string. Caller MUST free via ocr_free_string().
 *         Returns NULL if no error has occurred.
 */
OCR_API const char* ocr_get_last_error(OCRHandle* handle);

/**
 * @brief Helper to construct a quadrilateral bounding box from an axis-aligned rectangle.
 *
 * @param x       Top-left X coordinate of the rectangle.
 * @param y       Top-left Y coordinate of the rectangle.
 * @param width   Width of the rectangle.
 * @param height  Height of the rectangle.
 * @return Bounding box representing the rectangle.
 */
OCR_API OCRBBox ocr_bbox_from_rect(float x, float y, float width, float height);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* OCR_CORE_API_H */
