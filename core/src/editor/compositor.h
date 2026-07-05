/**
 * @file compositor.h
 * @brief Compositor — Text rendering and image compositing.
 *
 * Handles rendering replacement text onto images and compositing
 * multiple image layers (original + inpainted + text overlay).
 */

#ifndef OCR_COMPOSITOR_H
#define OCR_COMPOSITOR_H

#include "preprocessor/preprocessor.h"
#include "ocr_core_api.h"
#include <string>

namespace ocr {

class Compositor {
public:
    Compositor() = default;
    ~Compositor() = default;

    /**
     * @brief Render new text onto an image at a bounding box location.
     *
     * @param background       The background image (typically after inpainting).
     * @param box              Where to place the new text.
     * @param text             UTF-8 text to render.
     * @param font_config_json Optional font configuration JSON.
     * @return Image with text rendered at the specified location.
     */
    Image renderText(const Image& background, const OCRBBox& box,
                     const char* text, const char* font_config_json);
};

} // namespace ocr

#endif // OCR_COMPOSITOR_H
