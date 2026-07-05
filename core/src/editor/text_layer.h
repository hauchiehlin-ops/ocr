/**
 * @file text_layer.h
 * @brief Text Layer Manager — Manages the editable text overlay.
 *
 * Maintains the Positional Text Tree data structure and provides
 * methods to query, modify, and serialize the OCR results.
 */

#ifndef OCR_TEXT_LAYER_H
#define OCR_TEXT_LAYER_H

#include "ocr/paddle_ocr_engine.h"
#include <string>

namespace ocr {

class TextLayer {
public:
    TextLayer() = default;
    ~TextLayer() = default;

    /**
     * @brief Build the Positional Text Tree JSON from OCR results.
     *
     * Converts the internal OCRResult structure into the standardized
     * JSON format consumed by all platform UI layers.
     *
     * @param result        OCR recognition result.
     * @param image_width   Original image width.
     * @param image_height  Original image height.
     * @return JSON string in the Positional Text Tree schema.
     */
    std::string buildResultJSON(const OCRResult& result,
                                int image_width, int image_height);
};

} // namespace ocr

#endif // OCR_TEXT_LAYER_H
