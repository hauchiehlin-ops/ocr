#ifndef DOCUMENT_HISTORY_MANAGER_H
#define DOCUMENT_HISTORY_MANAGER_H

#include <string>
#include <vector>
#include <mutex>
#include "../../third_party/sqlite/sqlite3.h"

namespace ocr {

struct DocumentRecord {
    std::string id;
    std::string title;
    std::string json_data;
    std::string preview_image_path;
    int64_t timestamp;
};

class DocumentHistoryManager {
public:
    static DocumentHistoryManager& getInstance();

    bool init(const std::string& dbPath);
    bool saveDocument(const std::string& docId, const std::string& jsonData, const std::string& title, const std::string& previewPath);
    bool deleteDocument(const std::string& docId);
    std::vector<DocumentRecord> getAllDocuments();
    std::string getDocumentData(const std::string& docId);

private:
    DocumentHistoryManager();
    ~DocumentHistoryManager();

    // Delete copy and move
    DocumentHistoryManager(const DocumentHistoryManager&) = delete;
    DocumentHistoryManager& operator=(const DocumentHistoryManager&) = delete;

    sqlite3* db_;
    std::mutex mutex_;
    bool initialized_;

    bool createTableIfNotExists();
};

} // namespace ocr

#endif // DOCUMENT_HISTORY_MANAGER_H
