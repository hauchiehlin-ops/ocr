#ifndef DOCUMENT_EXPORTER_H
#define DOCUMENT_EXPORTER_H

#include <string>

namespace ocr {

class DocumentExporter {
public:
    // Exports the Positional Text Tree JSON to Markdown, maintaining structure
    static std::string exportToMarkdown(const std::string& ocrJson);
    
    // Exports table structures from the OCR JSON to CSV format
    static std::string exportToCSV(const std::string& ocrJson);
    
    // Exports a searchable PDF (Image + Hidden Text Layer)
    // Returns true on success, false otherwise
    static bool exportToSearchablePDF(const std::string& imagePath, const std::string& ocrJson, const std::string& outputPath);
};

} // namespace ocr

#endif // DOCUMENT_EXPORTER_H
