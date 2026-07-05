#include "compositor.h"
#include <cmath>
#include <algorithm>
#include <sstream>

namespace ocr {

Image Compositor::renderText(const Image& background, const OCRBBox& box,
                              const char* text, const char* font_config_json) {
    if (background.empty() || !text) {
        return background;
    }

    // Default font color is black (0, 0, 0)
    uint8_t color[3] = {0, 0, 0};

    // Simple parser for color in JSON: "color_rgb": [R, G, B]
    if (font_config_json) {
        std::string json_str(font_config_json);
        size_t pos = json_str.find("color_rgb");
        if (pos != std::string::npos) {
            size_t start = json_str.find("[", pos);
            size_t end = json_str.find("]", pos);
            if (start != std::string::npos && end != std::string::npos && end > start) {
                std::string rgb_sub = json_str.substr(start + 1, end - start - 1);
                std::stringstream ss(rgb_sub);
                int r = 0, g = 0, b = 0;
                char comma;
                if (ss >> r >> comma >> g >> comma >> b) {
                    color[0] = static_cast<uint8_t>(r);
                    color[1] = static_cast<uint8_t>(g);
                    color[2] = static_cast<uint8_t>(b);
                }
            }
        }
    }

    // Calculate axis-aligned bounding rect
    float min_x = std::min({box.top_left[0], box.bottom_left[0], box.top_right[0], box.bottom_right[0]});
    float min_y = std::min({box.top_left[1], box.top_right[1], box.bottom_left[1], box.bottom_right[1]});
    float max_x = std::max({box.top_left[0], box.bottom_left[0], box.top_right[0], box.bottom_right[0]});
    float max_y = std::max({box.top_left[1], box.top_right[1], box.bottom_left[1], box.bottom_right[1]});

    int x0 = std::max(0, static_cast<int>(min_x));
    int y0 = std::max(0, static_cast<int>(min_y));
    int x1 = std::min(background.width() - 1, static_cast<int>(std::ceil(max_x)));
    int y1 = std::min(background.height() - 1, static_cast<int>(std::ceil(max_y)));

    Image output = background;

    // Draw horizontal text line inside the bounding box using the target color
    int mid_y = y0 + (y1 - y0) / 2;
    int line_thickness = std::max(2, (y1 - y0) / 4);

    for (int y = mid_y - line_thickness / 2; y <= mid_y + line_thickness / 2; y++) {
        if (y < 0 || y >= background.height()) continue;
        int padding = std::max(2, (x1 - x0) / 10);
        for (int x = x0 + padding; x <= x1 - padding; x++) {
            uint8_t* px = output.pixel(x, y);
            px[0] = color[0];
            px[1] = color[1];
            px[2] = color[2];
        }
    }

    return output;
}

} // namespace ocr
