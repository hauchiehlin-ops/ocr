#include "DocumentExporter.h"
#include "../../third_party/nlohmann/json.hpp"
#include <sstream>
#include <algorithm>

namespace ocr {

std::string DocumentExporter::exportToMarkdown(const std::string& ocrJson) {
    if (ocrJson.empty()) return "";

    try {
        auto root = nlohmann::json::parse(ocrJson);
        if (!root.contains("blocks")) return "";

        std::stringstream md;
        auto blocks = root["blocks"];

        for (const auto& block : blocks) {
            if (!block.contains("lines")) continue;

            // Optional: determine block type (header vs paragraph) based on font estimate
            // For now, we simply iterate lines and append to md
            for (const auto& line : block["lines"]) {
                if (line.contains("text")) {
                    std::string text = line["text"];
                    
                    // A simple heuristic for Headers could be added here
                    // e.g., if font_size > 24, output as "## " + text
                    md << text << "\n";
                }
            }
            md << "\n"; // Paragraph break between blocks
        }

        return md.str();
    } catch (...) {
        return "";
    }
}

} // namespace ocr
