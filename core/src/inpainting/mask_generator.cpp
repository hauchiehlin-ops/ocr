/**
 * @file mask_generator.cpp
 * @brief Mask Generator — Implementation
 */

#include "mask_generator.h"
#include <cmath>
#include <algorithm>

namespace ocr {

Image MaskGenerator::generateMask(int width, int height,
                                   const OCRBBox* boxes, int box_count,
                                   int dilation) {
    // Create a blank mask (all zeros = preserve everything)
    Image mask(width, height, 4);

    for (int i = 0; i < box_count; i++) {
        const OCRBBox& box = boxes[i];

        // 1. Calculate centroid of the quadrilateral
        float cx = (box.top_left[0] + box.top_right[0] + box.bottom_right[0] + box.bottom_left[0]) / 4.0f;
        float cy = (box.top_left[1] + box.top_right[1] + box.bottom_right[1] + box.bottom_left[1]) / 4.0f;

        // 2. Expand corners along centroid direction by dilation * sqrt(2)
        struct Point { float x, y; };
        Point pts[4] = {
            { box.top_left[0], box.top_left[1] },
            { box.top_right[0], box.top_right[1] },
            { box.bottom_right[0], box.bottom_right[1] },
            { box.bottom_left[0], box.bottom_left[1] }
        };

        for (int p = 0; p < 4; p++) {
            float dx = pts[p].x - cx;
            float dy = pts[p].y - cy;
            float len = std::sqrt(dx * dx + dy * dy);
            if (len > 0.001f) {
                pts[p].x += (dx / len) * (dilation * 1.414f);
                pts[p].y += (dy / len) * (dilation * 1.414f);
            }
        }

        // 3. Scanline polygon fill
        float min_y = std::min({pts[0].y, pts[1].y, pts[2].y, pts[3].y});
        float max_y = std::max({pts[0].y, pts[1].y, pts[2].y, pts[3].y});

        int y_start = std::max(0, static_cast<int>(std::floor(min_y)));
        int y_end = std::min(height - 1, static_cast<int>(std::ceil(max_y)));

        for (int y = y_start; y <= y_end; y++) {
            std::vector<float> intersections;

            for (int e = 0; e < 4; e++) {
                const Point& A = pts[e];
                const Point& B = pts[(e + 1) % 4];

                // Check if scanline y intersects edge AB
                if ((A.y <= y && B.y > y) || (B.y <= y && A.y > y)) {
                    if (std::abs(B.y - A.y) > 0.0001f) {
                        float t = (static_cast<float>(y) - A.y) / (B.y - A.y);
                        float intersect_x = A.x + t * (B.x - A.x);
                        intersections.push_back(intersect_x);
                    }
                }
            }

            if (intersections.size() >= 2) {
                std::sort(intersections.begin(), intersections.end());
                int x_start = std::max(0, static_cast<int>(std::floor(intersections.front())));
                int x_end = std::min(width - 1, static_cast<int>(std::ceil(intersections.back())));

                for (int x = x_start; x <= x_end; x++) {
                    uint8_t* px = mask.pixel(x, y);
                    px[0] = px[1] = px[2] = px[3] = 255;
                }
            }
        }
    }

    return mask;
}

} // namespace ocr
