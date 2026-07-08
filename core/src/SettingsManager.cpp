#include "SettingsManager.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include "../third_party/nlohmann/json.hpp"

using json = nlohmann::json;

namespace ocr {

SettingsManager::SettingsManager() {
}

SettingsManager::~SettingsManager() {
}

void SettingsManager::setFilePath(const std::string& path) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_file_path = path;
}

std::string SettingsManager::getString(const std::string& key, const std::string& default_val) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_settings.find(key);
    if (it != m_settings.end()) {
        return it->second;
    }
    return default_val;
}

void SettingsManager::setString(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_settings[key] = value;
}

int SettingsManager::getInt(const std::string& key, int default_val) const {
    std::string val_str = getString(key, "");
    if (val_str.empty()) return default_val;
    try {
        return std::stoi(val_str);
    } catch (...) {
        return default_val;
    }
}

void SettingsManager::setInt(const std::string& key, int value) {
    setString(key, std::to_string(value));
}

bool SettingsManager::load() {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_file_path.empty()) return false;

    std::ifstream ifs(m_file_path);
    if (!ifs.is_open()) return false;

    try {
        json j;
        ifs >> j;
        m_settings.clear();
        for (auto& el : j.items()) {
            if (el.value().is_string()) {
                m_settings[el.key()] = el.value().get<std::string>();
            } else {
                m_settings[el.key()] = el.value().dump(); // Convert int/bool to string
            }
        }
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Settings load error: " << e.what() << std::endl;
        return false;
    }
}

bool SettingsManager::save() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_file_path.empty()) return false;

    std::ofstream ofs(m_file_path);
    if (!ofs.is_open()) return false;

    try {
        json j;
        for (const auto& pair : m_settings) {
            j[pair.first] = pair.second;
        }
        ofs << j.dump(4);
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Settings save error: " << e.what() << std::endl;
        return false;
    }
}

std::string SettingsManager::toJsonString() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    try {
        json j;
        for (const auto& pair : m_settings) {
            j[pair.first] = pair.second;
        }
        return j.dump();
    } catch (...) {
        return "{}";
    }
}

bool SettingsManager::fromJsonString(const std::string& json_str) {
    std::lock_guard<std::mutex> lock(m_mutex);
    try {
        json j = json::parse(json_str);
        for (auto& el : j.items()) {
            if (el.value().is_string()) {
                m_settings[el.key()] = el.value().get<std::string>();
            } else {
                m_settings[el.key()] = el.value().dump();
            }
        }
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace ocr
