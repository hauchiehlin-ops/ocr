/**
 * @file paddle_ocr_engine.h
 * @brief PaddleOCR v5 — OCR Recognition Engine (via ONNX Runtime)
 *
 * Implements the three-stage PaddleOCR pipeline:
 *   1. Text Detection (DB model)    → Detects text regions
 *   2. Direction Classification      → Corrects rotation (0°/180°)
 *   3. Text Recognition (CRNN model) → Recognizes characters
 *
 * Models are loaded in ONNX format and executed via ONNX Runtime,
 * which provides hardware-accelerated inference on all platforms:
 *   - iOS:     CoreML EP
 *   - Android: NNAPI EP
 *   - macOS:   Metal EP (Apple Silicon) / CPU EP (Intel)
 *   - Windows: DirectML EP (GPU) / CPU EP
 */

#ifndef OCR_PADDLE_OCR_ENGINE_H
#define OCR_PADDLE_OCR_ENGINE_H

#include "preprocessor/preprocessor.h"  // for ocr::Image
#include <string>
#include <vector>
#include <memory>

namespace ocr {

/**
 * @brief Represents a single detected word with position and confidence.
 */
struct DetectedWord {
    std::string text;           ///< Recognized text content
    float confidence;           ///< Recognition confidence [0.0, 1.0]
    float bbox[8];              ///< Quadrilateral: [tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y]
    float font_size_estimate;   ///< Estimated font size in pixels
    uint8_t color_rgb[3];       ///< Estimated text color
    bool is_bold;               ///< Estimated bold state
};

/**
 * @brief Represents a line of detected text.
 */
struct DetectedLine {
    std::string text;                       ///< Full line text
    float confidence;                       ///< Average confidence
    float bbox[8];                          ///< Line bounding box
    std::vector<DetectedWord> words;        ///< Individual words in this line
};

/**
 * @brief Represents a block of detected text (paragraph, table, etc.)
 */
struct DetectedBlock {
    std::string id;                         ///< Unique block identifier
    std::string type;                       ///< Block type: "paragraph", "table", etc.
    float confidence;                       ///< Average confidence
    float bbox[8];                          ///< Block bounding box
    std::vector<DetectedLine> lines;        ///< Lines within this block
};

/**
 * @brief Full OCR recognition result.
 */
struct OCRResult {
    std::vector<DetectedBlock> blocks;      ///< All detected text blocks
    int image_width;                        ///< Original image width
    int image_height;                       ///< Original image height

    /// Get all text concatenated
    std::string fullText() const {
        std::string result;
        for (const auto& block : blocks) {
            for (const auto& line : block.lines) {
                result += line.text + "\n";
            }
            result += "\n";
        }
        return result;
    }

    /// Total number of detected words
    int wordCount() const {
        int count = 0;
        for (const auto& block : blocks) {
            for (const auto& line : block.lines) {
                count += static_cast<int>(line.words.size());
            }
        }
        return count;
    }
};

/**
 * @brief PaddleOCR v5 Engine — ONNX Runtime-based OCR recognition.
 *
 * Usage:
 * @code
 *   ocr::PaddleOCREngine engine("/path/to/models");
 *   ocr::OCRResult result = engine.recognize(image);
 *   std::cout << result.fullText() << std::endl;
 * @endcode
 */
class PaddleOCREngine {
public:
    /**
     * @brief Construct and initialize the OCR engine.
     *
     * @param model_dir  Directory containing ONNX model files:
     *                   - ppocr_det_v5.onnx (text detection, ~4MB)
     *                   - ppocr_rec_v5.onnx (text recognition, ~12MB)
     *                   - ppocr_cls_v5.onnx (direction classification, ~1MB)
     *
     * @throws std::runtime_error if model files are not found or loading fails.
     */
    explicit PaddleOCREngine(const std::string& model_dir, const std::string& config_json = "");
    ~PaddleOCREngine();

    // Non-copyable
    PaddleOCREngine(const PaddleOCREngine&) = delete;
    PaddleOCREngine& operator=(const PaddleOCREngine&) = delete;

    /**
     * @brief Perform OCR recognition on a preprocessed image.
     *
     * @param image  Preprocessed input image (RGBA format).
     * @return OCRResult containing all detected text with positions.
     */
    OCRResult recognize(const Image& image);

    /**
     * @brief Check if the engine is properly initialized.
     */
    bool isReady() const;

    /**
     * @brief Set the confidence threshold for text detection.
     *
     * @param threshold  Minimum confidence [0.0, 1.0]. Default: 0.5
     */
    void setConfidenceThreshold(float threshold);

    /**
     * @brief Set the language for recognition.
     *
     * @param lang  Language code ("ch" for Chinese, "en" for English, etc.)
     */
    void setLanguage(const std::string& lang);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    /// Detection phase: find text regions in the image
    std::vector<std::vector<float>> detectTextRegions(const Image& image);

    /// Classification phase: determine text direction (0° or 180°)
    void classifyDirection(const Image& image,
                          std::vector<std::vector<float>>& regions);

    /// Recognition phase: recognize text in each detected region
    std::vector<DetectedWord> recognizeRegions(
        const Image& image,
        const std::vector<std::vector<float>>& regions);

    /// Post-processing: group words into lines and blocks
    OCRResult buildResult(const std::vector<DetectedWord>& words,
                         int image_width, int image_height);

    /// Estimate font properties from the detected text region
    void estimateFontProperties(DetectedWord& word, const Image& image);
};

} // namespace ocr

#endif // OCR_PADDLE_OCR_ENGINE_H
