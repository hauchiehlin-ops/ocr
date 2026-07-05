/**
 * @file text_layer.cpp
 * @brief Text Layer Manager — JSON serialization implementation.
 */

#include "text_layer.h"
#include <sstream>
#include <iomanip>

namespace ocr {

/// Helper: Escape a string for JSON output
static std::string jsonEscape(const std::string& str) {
    std::string result;
    result.reserve(str.size() + 16);
    for (char c : str) {
        switch (c) {
            case '"':  result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:   result += c; break;
        }
    }
    return result;
}

/// Helper: Format a bounding box as JSON
static std::string bboxToJSON(const float bbox[8]) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(1);
    ss << "{"
       << "\"top_left\":[" << bbox[0] << "," << bbox[1] << "],"
       << "\"top_right\":[" << bbox[2] << "," << bbox[3] << "],"
       << "\"bottom_right\":[" << bbox[4] << "," << bbox[5] << "],"
       << "\"bottom_left\":[" << bbox[6] << "," << bbox[7] << "]"
       << "}";
    return ss.str();
}

std::string TextLayer::buildResultJSON(const OCRResult& result,
                                        int image_width, int image_height) {
    std::ostringstream json;
    json << std::fixed << std::setprecision(2);

    json << "{";
    json << "\"image_id\":\"ocr_result\",";
    json << "\"dimensions\":{\"width\":" << image_width
         << ",\"height\":" << image_height << "},";
    json << "\"text_blocks\":[";

    for (size_t bi = 0; bi < result.blocks.size(); bi++) {
        const auto& block = result.blocks[bi];
        if (bi > 0) json << ",";

        json << "{";
        json << "\"id\":\"" << jsonEscape(block.id) << "\",";
        json << "\"type\":\"" << jsonEscape(block.type) << "\",";
        json << "\"confidence\":" << block.confidence << ",";
        json << "\"bounding_box\":" << bboxToJSON(block.bbox) << ",";
        json << "\"lines\":[";

        for (size_t li = 0; li < block.lines.size(); li++) {
            const auto& line = block.lines[li];
            if (li > 0) json << ",";

            json << "{";
            json << "\"id\":\"line_" << bi << "_" << li << "\",";
            json << "\"text\":\"" << jsonEscape(line.text) << "\",";
            json << "\"confidence\":" << line.confidence << ",";
            json << "\"bounding_box\":" << bboxToJSON(line.bbox) << ",";
            json << "\"words\":[";

            for (size_t wi = 0; wi < line.words.size(); wi++) {
                const auto& word = line.words[wi];
                if (wi > 0) json << ",";

                json << "{";
                json << "\"id\":\"word_" << bi << "_" << li << "_" << wi << "\",";
                json << "\"text\":\"" << jsonEscape(word.text) << "\",";
                json << "\"confidence\":" << word.confidence << ",";
                json << "\"bounding_box\":" << bboxToJSON(word.bbox) << ",";
                json << "\"font_estimate\":{";
                json << "\"size_px\":" << word.font_size_estimate << ",";
                json << "\"color_rgb\":[" << (int)word.color_rgb[0] << ","
                     << (int)word.color_rgb[1] << ","
                     << (int)word.color_rgb[2] << "],";
                json << "\"is_bold\":" << (word.is_bold ? "true" : "false");
                json << "}";
                json << "}";
            }

            json << "]}"; // end words, end line
        }

        json << "]}"; // end lines, end block
    }

    json << "]}"; // end text_blocks, end root
    return json.str();
}

} // namespace ocr
