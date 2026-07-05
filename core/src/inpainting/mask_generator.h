/**
 * @file mask_generator.h
 * @brief Mask Generator — Creates binary masks from bounding boxes.
 */

#ifndef OCR_MASK_GENERATOR_H
#define OCR_MASK_GENERATOR_H

#include "preprocessor/preprocessor.h"
#include "ocr_core_api.h"

namespace ocr {

class MaskGenerator {
public:
    MaskGenerator() = default;
    ~MaskGenerator() = default;

    /**
     * @brief Generate a binary mask from an array of bounding boxes.
     *
     * The mask has the same dimensions as the target image.
     * White (255) pixels indicate regions to be inpainted.
     * Black (0) pixels indicate regions to preserve.
     *
     * @param width      Image width.
     * @param height     Image height.
     * @param boxes      Array of bounding boxes to mask.
     * @param box_count  Number of bounding boxes.
     * @param dilation   Pixels to expand mask beyond bbox edges (default: 3).
     * @return Binary mask image (single-channel conceptually, stored as RGBA).
     */
    Image generateMask(int width, int height,
                       const OCRBBox* boxes, int box_count,
                       int dilation = 3);
};

} // namespace ocr

#endif // OCR_MASK_GENERATOR_H
