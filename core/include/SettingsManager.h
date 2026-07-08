#ifndef SETTINGS_MANAGER_H
#define SETTINGS_MANAGER_H

#include <string>
#include <mutex>
#include <unordered_map>

namespace ocr {

class SettingsManager {
public:
    SettingsManager();
    ~SettingsManager();

    // Sets the file path for the settings JSON
    void setFilePath(const std::string& path);

    // Get/Set string values
    std::string getString(const std::string& key, const std::string& default_val = "") const;
    void setString(const std::string& key, const std::string& value);

    // Get/Set int values
    int getInt(const std::string& key, int default_val = 0) const;
    void setInt(const std::string& key, int value);

    // Load from disk
    bool load();

    // Save to disk
    bool save() const;

    // Returns the entire settings as a JSON string
    std::string toJsonString() const;
    
    // Updates settings from a JSON string
    bool fromJsonString(const std::string& json_str);

private:
    std::string m_file_path;
    mutable std::mutex m_mutex;
    std::unordered_map<std::string, std::string> m_settings;
};

} // namespace ocr

#endif // SETTINGS_MANAGER_H
