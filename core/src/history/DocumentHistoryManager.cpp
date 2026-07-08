#include "DocumentHistoryManager.h"
#include <iostream>
#include <chrono>

namespace ocr {

DocumentHistoryManager& DocumentHistoryManager::getInstance() {
    static DocumentHistoryManager instance;
    return instance;
}

DocumentHistoryManager::DocumentHistoryManager() : db_(nullptr), initialized_(false) {}

DocumentHistoryManager::~DocumentHistoryManager() {
    if (db_) {
        sqlite3_close(db_);
    }
}

bool DocumentHistoryManager::init(const std::string& dbPath) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (initialized_) return true;

    int rc = sqlite3_open(dbPath.c_str(), &db_);
    if (rc != SQLITE_OK) {
        std::cerr << "Cannot open database: " << sqlite3_errmsg(db_) << std::endl;
        return false;
    }

    if (!createTableIfNotExists()) {
        return false;
    }

    initialized_ = true;
    return true;
}

bool DocumentHistoryManager::createTableIfNotExists() {
    const char* sql = "CREATE TABLE IF NOT EXISTS documents ("
                      "id TEXT PRIMARY KEY, "
                      "title TEXT, "
                      "json_data TEXT, "
                      "preview_image_path TEXT, "
                      "timestamp INTEGER);";

    char* errMsg = nullptr;
    int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &errMsg);

    if (rc != SQLITE_OK) {
        std::cerr << "SQL error creating table: " << errMsg << std::endl;
        sqlite3_free(errMsg);
        return false;
    }
    return true;
}

bool DocumentHistoryManager::saveDocument(const std::string& docId, const std::string& jsonData, const std::string& title, const std::string& previewPath) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!initialized_) return false;

    auto now = std::chrono::system_clock::now();
    int64_t timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();

    const char* sql = "INSERT OR REPLACE INTO documents (id, title, json_data, preview_image_path, timestamp) "
                      "VALUES (?, ?, ?, ?, ?);";
    
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        std::cerr << "Failed to prepare statement: " << sqlite3_errmsg(db_) << std::endl;
        return false;
    }

    sqlite3_bind_text(stmt, 1, docId.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, title.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 3, jsonData.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 4, previewPath.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 5, timestamp);

    bool success = (sqlite3_step(stmt) == SQLITE_DONE);
    if (!success) {
        std::cerr << "Failed to execute statement: " << sqlite3_errmsg(db_) << std::endl;
    }

    sqlite3_finalize(stmt);
    return success;
}

bool DocumentHistoryManager::deleteDocument(const std::string& docId) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!initialized_) return false;

    const char* sql = "DELETE FROM documents WHERE id = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    sqlite3_bind_text(stmt, 1, docId.c_str(), -1, SQLITE_STATIC);

    bool success = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return success;
}

std::vector<DocumentRecord> DocumentHistoryManager::getAllDocuments() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<DocumentRecord> docs;
    if (!initialized_) return docs;

    const char* sql = "SELECT id, title, preview_image_path, timestamp FROM documents ORDER BY timestamp DESC;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return docs;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        DocumentRecord doc;
        doc.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        const char* titleStr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        doc.title = titleStr ? titleStr : "";
        
        const char* previewStr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        doc.preview_image_path = previewStr ? previewStr : "";
        
        doc.timestamp = sqlite3_column_int64(stmt, 3);
        
        // Exclude json_data here to save memory, use getDocumentData when needed
        docs.push_back(doc);
    }

    sqlite3_finalize(stmt);
    return docs;
}

std::string DocumentHistoryManager::getDocumentData(const std::string& docId) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!initialized_) return "";

    const char* sql = "SELECT json_data FROM documents WHERE id = ?;";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return "";

    sqlite3_bind_text(stmt, 1, docId.c_str(), -1, SQLITE_STATIC);

    std::string result = "";
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        const char* data = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        if (data) {
            result = data;
        }
    }

    sqlite3_finalize(stmt);
    return result;
}

} // namespace ocr
