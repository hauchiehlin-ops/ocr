#pragma once

#include <string>
#include <vector>

namespace ocr {

struct CanvasBBox {
    float top_left[2];
    float top_right[2];
    float bottom_right[2];
    float bottom_left[2];
};

struct ParsedLayer {
    std::string id;
    std::string type; // "text", "image", "vector"
    std::string name;
    std::string text; // For text layers
    CanvasBBox bbox;
    float font_size = 14.0f;
    uint8_t font_color[3] = {0, 0, 0};
    bool is_bold = false;
    std::string image_path; // For image layers
};

struct ParsedSlide {
    int slide_number;
    int width = 1920;
    int height = 1080;
    std::vector<ParsedLayer> layers;
};

class DocumentParser {
public:
    DocumentParser() = default;
    ~DocumentParser() = default;

    /**
     * @brief Parse a PPTX file and extract slide layers.
     * @param pptx_path The path to the PPTX file.
     * @return A JSON string describing slides and layers.
     */
    std::string parsePptx(const std::string& pptx_path) const;
};

} // namespace ocr
