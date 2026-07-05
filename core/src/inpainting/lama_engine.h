/**
 * @file lama_engine.h
 * @brief LaMa (Large Mask Inpainting) Engine — AI Text Removal
 *
 * Uses the LaMa model (Fast Fourier Convolutions) to intelligently
 * fill regions where text has been removed, maintaining the
 * background texture and context.
 *
 * Model: ~50MB (ONNX format), ~15MB (INT8 quantized)
 * Supports: 2K resolution, CPU + GPU inference
 * License: Apache 2.0 (commercial use allowed)
 */

#ifndef OCR_LAMA_ENGINE_H
#define OCR_LAMA_ENGINE_H

#include "preprocessor/preprocessor.h"  // for ocr::Image
#include <string>
#include <memory>

namespace ocr {

/**
 * @brief LaMa Inpainting Engine for text removal.
 *
 * Usage:
 * @code
 *   ocr::LaMaEngine engine("/path/to/models");
 *   ocr::Image mask = ...; // Binary mask (255 = area to fill)
 *   ocr::Image result = engine.inpaint(original_image, mask);
 * @endcode
 */
class LaMaEngine {
public:
    explicit LaMaEngine(const std::string& model_dir);
    ~LaMaEngine();

    LaMaEngine(const LaMaEngine&) = delete;
    LaMaEngine& operator=(const LaMaEngine&) = delete;

    /**
     * @brief Inpaint masked regions of an image.
     *
     * @param image  Original image (RGBA).
     * @param mask   Binary mask — 255 for regions to fill, 0 for keep.
     *               Must have same dimensions as image (single channel or RGBA).
     * @return Image with masked regions filled by AI inpainting.
     */
    Image inpaint(const Image& image, const Image& mask);

    bool isReady() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace ocr

#endif // OCR_LAMA_ENGINE_H
