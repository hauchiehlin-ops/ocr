#ifndef OCR_LOCAL_LLM_ENGINE_H
#define OCR_LOCAL_LLM_ENGINE_H

#include <string>
#include <memory>
#include <vector>

namespace ocr {

/**
 * @brief Manages a local Large Language Model (e.g. Llama-3, Qwen) using llama.cpp.
 * 
 * Provides capabilities to fix OCR errors, translate text, and extract structured data
 * purely offline on the user's device.
 */
class LocalLLMEngine {
public:
    LocalLLMEngine();
    ~LocalLLMEngine();

    // Disable copy/move
    LocalLLMEngine(const LocalLLMEngine&) = delete;
    LocalLLMEngine& operator=(const LocalLLMEngine&) = delete;

    /**
     * @brief Loads a GGUF model from the specified file path.
     * @param modelPath The absolute path to the .gguf model file.
     * @return true if successful, false otherwise.
     */
    bool loadModel(const std::string& modelPath);

    /**
     * @brief Checks if a model is currently loaded and ready for inference.
     */
    bool isReady() const;

    /**
     * @brief Instructs the LLM to fix OCR typos and formatting in the provided text.
     * @param brokenText The raw text output from the OCR engine.
     * @return The corrected, semantically sound text.
     */
    std::string fixOcrText(const std::string& brokenText);

    /**
     * @brief Translates the text to a target language.
     * @param text The source text.
     * @param targetLanguage e.g., "English", "Traditional Chinese", "Japanese"
     * @return The translated text.
     */
    std::string translate(const std::string& text, const std::string& targetLanguage);

    /**
     * @brief Extracts key-value pairs (JSON format) from a document like a receipt.
     * @param text The raw document text.
     * @return A JSON string representing the extracted entities.
     */
    std::string extractEntities(const std::string& text);

private:
    /**
     * @brief Core inference function. 
     * @param prompt The complete, formatted prompt for the instruction-tuned model.
     * @return The generated response string.
     */
    std::string generateResponse(const std::string& prompt);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace ocr

#endif // OCR_LOCAL_LLM_ENGINE_H
