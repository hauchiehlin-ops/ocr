#ifndef DOCUMENT_EXPORTER_H
#define DOCUMENT_EXPORTER_H

#include <string>

namespace ocr {

class DocumentExporter {
public:
    // Exports the Positional Text Tree JSON to Markdown, maintaining structure
    static std::string exportToMarkdown(const std::string& ocrJson);
};

} // namespace ocr

#endif // DOCUMENT_EXPORTER_H
