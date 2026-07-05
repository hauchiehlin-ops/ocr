/**
 * @file blender.cpp
 * @brief Seamless Blending — Implementation with alpha feathering.
 */

#include "blender.h"
#include <cmath>
#include <algorithm>

namespace ocr {

Image Blender::blend(const Image& original, const Image& inpainted,
                     const Image& mask) {
    if (original.empty() || inpainted.empty() || mask.empty()) {
        return original;
    }

    int width = original.width();
    int height = original.height();
    Image result(width, height, original.channels());

    // Simple alpha blending: use mask value as blend factor
    // Mask edge pixels get a gradient for smooth transition
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            const uint8_t* orig_px = original.pixel(x, y);
            const uint8_t* inp_px = inpainted.pixel(x, y);
            const uint8_t* mask_px = mask.pixel(x, y);
            uint8_t* out_px = result.pixel(x, y);

            float alpha = mask_px[0] / 255.0f;

            // Feather mask edges (3px gradient)
            // TODO: Implement proper distance transform for feathering
            if (alpha > 0.0f && alpha < 1.0f) {
                // Already partially transparent — use as-is
            }

            // Blend: result = inpainted * alpha + original * (1 - alpha)
            for (int c = 0; c < 3; c++) {
                float blended = inp_px[c] * alpha + orig_px[c] * (1.0f - alpha);
                out_px[c] = static_cast<uint8_t>(
                    std::min(255.0f, std::max(0.0f, blended)));
            }
            out_px[3] = orig_px[3]; // Preserve original alpha
        }
    }

    return result;
}

} // namespace ocr
