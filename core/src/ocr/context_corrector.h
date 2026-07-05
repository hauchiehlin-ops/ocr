#pragma once

#include <string>
#include <vector>
#include <unordered_set>
#include <unordered_map>

namespace ocr {

class ContextCorrector {
public:
    ContextCorrector();
    ~ContextCorrector();

    /**
     * @brief Correct common spelling/OCR typos in a single word.
     * @param word The original OCR-recognized word.
     * @param confidence The confidence of the OCR output (0.0 to 1.0).
     * @return The corrected word.
     */
    std::string correctWord(const std::string& word, float confidence) const;

    /**
     * @brief Correct full lines of text and standard CJK punctuation.
     * @param text The full recognized text line.
     * @return The corrected text.
     */
    std::string correctTextLine(const std::string& text) const;

private:
    void initDictionary();
    void initConfusionPairs();

    std::unordered_set<std::string> dictionary_;
    std::unordered_map<char, char> digit_to_alpha_confusions_;
    std::unordered_map<char, char> alpha_to_digit_confusions_;
};

} // namespace ocr
