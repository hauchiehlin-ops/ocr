/**
 * @file blender.h / blender.cpp
 * @brief Seamless Blending — Poisson blending for natural edge transitions.
 */

#ifndef OCR_BLENDER_H
#define OCR_BLENDER_H

#include "preprocessor/preprocessor.h"

namespace ocr {

class Blender {
public:
    Blender() = default;
    ~Blender() = default;

    /**
     * @brief Blend inpainted regions seamlessly with the original image.
     *
     * Uses alpha blending at mask edges for smooth transitions.
     * TODO: Implement Poisson blending via OpenCV for better quality.
     *
     * @param original   The original image.
     * @param inpainted  The inpainted image (from LaMa).
     * @param mask       Binary mask (255 = inpainted region).
     * @return Seamlessly blended result.
     */
    Image blend(const Image& original, const Image& inpainted, const Image& mask);
};

} // namespace ocr

#endif // OCR_BLENDER_H
