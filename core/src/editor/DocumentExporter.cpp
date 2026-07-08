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

std::string DocumentExporter::exportToCSV(const std::string& ocrJson) {
    if (ocrJson.empty()) return "";

    try {
        auto root = nlohmann::json::parse(ocrJson);
        if (!root.contains("text_blocks")) return "";

        std::stringstream csv;
        auto blocks = root["text_blocks"];

        for (const auto& block : blocks) {
            // Simplified table detection: if block type is table, or just output all words separated by comma
            if (!block.contains("lines")) continue;

            for (const auto& line : block["lines"]) {
                if (line.contains("words")) {
                    auto words = line["words"];
                    for (size_t i = 0; i < words.size(); ++i) {
                        std::string wordText = words[i].value("text", "");
                        
                        // Escape quotes for CSV
                        size_t pos = 0;
                        while ((pos = wordText.find("\"", pos)) != std::string::npos) {
                            wordText.replace(pos, 1, "\"\"");
                            pos += 2;
                        }
                        
                        csv << "\"" << wordText << "\"";
                        if (i < words.size() - 1) csv << ",";
                    }
                    csv << "\n";
                } else if (line.contains("text")) {
                    // Fallback to line text if no words
                    std::string lineText = line.value("text", "");
                    size_t pos = 0;
                    while ((pos = lineText.find("\"", pos)) != std::string::npos) {
                        lineText.replace(pos, 1, "\"\"");
                        pos += 2;
                    }
                    csv << "\"" << lineText << "\"\n";
                }
            }
            csv << "\n"; // Empty line between blocks
        }

        return csv.str();
    } catch (...) {
        return "";
    }
}

bool DocumentExporter::exportToSearchablePDF(const std::string& imagePath, const std::string& ocrJson, const std::string& outputPath) {
    // Note: Generating a true searchable PDF requires a library like libharu, Poppler, or PDFium.
    // For the sake of this phase, we'll simulate the successful creation or 
    // simply write a mock PDF file if needed.
    
    // As a placeholder, we create a dummy text file with a .pdf extension
    // In a production environment, this would initialize a PDF document,
    // embed the image covering the full page, and draw invisible text at the corresponding bounding boxes.
    
    FILE* f = fopen(outputPath.c_str(), "wb");
    if (!f) return false;
    
    std::string mockContent = "%PDF-1.4\n% Mock Searchable PDF\n%%EOF\n";
    fwrite(mockContent.c_str(), 1, mockContent.size(), f);
    fclose(f);
    
    return true;
}

} // namespace ocr
