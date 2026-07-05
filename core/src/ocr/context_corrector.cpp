#include "context_corrector.h"
#include <algorithm>
#include <cctype>

namespace ocr {

ContextCorrector::ContextCorrector() {
    initDictionary();
    initConfusionPairs();
}

ContextCorrector::~ContextCorrector() = default;

void ContextCorrector::initDictionary() {
    // A small vocabulary of common terms used in the editor
    const std::vector<std::string> words = {
        "Hello", "World", "OCR", "Visual", "Editor", "Project",
        "Engine", "Paddle", "ONNX", "Runtime", "OpenCV", "LaMa",
        "Inpainting", "Image", "Text", "Select", "Delete", "Replace",
        "Cancel", "Confirm", "Settings", "Tools", "File", "Edit"
    };

    for (const auto& w : words) {
        std::string lower = w;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
        dictionary_.insert(lower);
        // Also insert original case
        dictionary_.insert(w);
    }
}

void ContextCorrector::initConfusionPairs() {
    // Digit to letter confusions (for mostly-alphabetic words)
    digit_to_alpha_confusions_['0'] = 'O';
    digit_to_alpha_confusions_['1'] = 'l'; // or 'I'
    digit_to_alpha_confusions_['2'] = 'z';
    digit_to_alpha_confusions_['5'] = 's';
    digit_to_alpha_confusions_['8'] = 'B';

    // Letter to digit confusions (for mostly-numeric words)
    alpha_to_digit_confusions_['O'] = '0';
    alpha_to_digit_confusions_['o'] = '0';
    alpha_to_digit_confusions_['I'] = '1';
    alpha_to_digit_confusions_['l'] = '1';
    alpha_to_digit_confusions_['z'] = '2';
    alpha_to_digit_confusions_['Z'] = '2';
    alpha_to_digit_confusions_['S'] = '5';
    alpha_to_digit_confusions_['s'] = '5';
    alpha_to_digit_confusions_['B'] = '8';
}

std::string ContextCorrector::correctWord(const std::string& word, float confidence) const {
    if (word.empty()) return word;

    // High confidence results don't need aggressive correction
    if (confidence > 0.98f) return word;

    // Check if the word is already in dictionary (exact or lowercase)
    if (dictionary_.count(word)) return word;
    std::string lower = word;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (dictionary_.count(lower)) {
        // Return original case version from dict if it exists, or just lower
        return word; // Keep original since it might be a name
    }

    // Count alpha vs digit characters
    int alphaCount = 0;
    int digitCount = 0;
    for (char c : word) {
        if (std::isalpha(static_cast<unsigned char>(c))) alphaCount++;
        else if (std::isdigit(static_cast<unsigned char>(c))) digitCount++;
    }

    // Case 1: Mostly letters, but has stray digits (e.g. "He11o", "0CR")
    if (alphaCount > 0 && digitCount > 0 && alphaCount > digitCount) {
        std::string corrected = word;
        for (char& c : corrected) {
            if (std::isdigit(static_cast<unsigned char>(c))) {
                auto it = digit_to_alpha_confusions_.find(c);
                if (it != digit_to_alpha_confusions_.end()) {
                    c = it->second;
                }
            }
        }
        // If corrected word is valid dictionary term, return it
        std::string corrLower = corrected;
        std::transform(corrLower.begin(), corrLower.end(), corrLower.begin(), ::tolower);
        if (dictionary_.count(corrLower)) {
            // Restore proper casing from dictionary if we can find it
            // Simple match:
            if (corrLower == "hello") return "Hello";
            if (corrLower == "world") return "World";
            if (corrLower == "ocr") return "OCR";
            if (corrLower == "visual") return "Visual";
            if (corrLower == "editor") return "Editor";
            return corrected;
        }
        return corrected;
    }

    // Case 2: Mostly digits, but has stray letters (e.g. "2O26", "1O0")
    if (digitCount > 0 && alphaCount > 0 && digitCount >= alphaCount) {
        std::string corrected = word;
        for (char& c : corrected) {
            if (std::isalpha(static_cast<unsigned char>(c))) {
                auto it = alpha_to_digit_confusions_.find(c);
                if (it != alpha_to_digit_confusions_.end()) {
                    c = it->second;
                }
            }
        }
        return corrected;
    }

    return word;
}

std::string ContextCorrector::correctTextLine(const std::string& text) const {
    if (text.empty()) return text;

    std::string result;
    result.reserve(text.size());

    // Simple CJK Full-width punctuation normalization
    // CJK characters in UTF-8 are 3-byte sequences starting with 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9.
    bool hasCJK = false;
    for (size_t i = 0; i < text.size(); i++) {
        unsigned char c = text[i];
        if (c >= 0xE0) {
            hasCJK = true;
            break;
        }
    }

    if (hasCJK) {
        for (size_t i = 0; i < text.size(); ) {
            unsigned char c = text[i];
            // If it is an ASCII punctuation next to CJK, convert to full-width
            if (c == ',' && i > 0 && static_cast<unsigned char>(text[i - 1]) >= 0x80) {
                result += "，"; // UTF-8 for ， is \xE3\x80\x8C etc, actually \xEF\xBC\x8C
                i++;
            } else if (c == '.' && i > 0 && static_cast<unsigned char>(text[i - 1]) >= 0x80) {
                result += "。"; // \xE3\x80\x82
                i++;
            } else if (c == '!' && i > 0 && static_cast<unsigned char>(text[i - 1]) >= 0x80) {
                result += "！"; // \xEF\xBC\x81
                i++;
            } else if (c == '?' && i > 0 && static_cast<unsigned char>(text[i - 1]) >= 0x80) {
                result += "？"; // \xEF\xBC\x9F
                i++;
            } else {
                result += text[i];
                i++;
            }
        }
        return result;
    }

    return text;
}

} // namespace ocr
