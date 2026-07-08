#include "LocalLLMEngine.h"

// Define a macro to conditionally compile llama.cpp parts only if enabled
#ifdef OCR_ENABLE_LLM
#include "llama.h"
#endif

#include <iostream>
#include <mutex>
#include <stdexcept>

namespace ocr {

struct LocalLLMEngine::Impl {
#ifdef OCR_ENABLE_LLM
    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    llama_batch batch;
    
    // Simple lock for thread-safe inference
    std::mutex inference_mutex;
#endif

    bool is_ready = false;
};

LocalLLMEngine::LocalLLMEngine() : impl_(std::make_unique<Impl>()) {
#ifdef OCR_ENABLE_LLM
    // Initialize the llama.cpp backend
    llama_backend_init();
#endif
}

LocalLLMEngine::~LocalLLMEngine() {
#ifdef OCR_ENABLE_LLM
    if (impl_->ctx) {
        llama_free(impl_->ctx);
        impl_->ctx = nullptr;
    }
    if (impl_->model) {
        llama_free_model(impl_->model);
        impl_->model = nullptr;
    }
    if (impl_->is_ready) {
        llama_batch_free(impl_->batch);
    }
    llama_backend_free();
#endif
}

bool LocalLLMEngine::loadModel(const std::string& modelPath) {
#ifdef OCR_ENABLE_LLM
    std::lock_guard<std::mutex> lock(impl_->inference_mutex);

    // Free existing model if any
    if (impl_->ctx) {
        llama_free(impl_->ctx);
        impl_->ctx = nullptr;
    }
    if (impl_->model) {
        llama_free_model(impl_->model);
        impl_->model = nullptr;
    }

    llama_model_params model_params = llama_model_default_params();
    // Enable GPU offloading if available
    model_params.n_gpu_layers = 99; // offload all layers to GPU

    impl_->model = llama_load_model_from_file(modelPath.c_str(), model_params);
    if (!impl_->model) {
        std::cerr << "[LocalLLMEngine] Failed to load model from: " << modelPath << std::endl;
        return false;
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 4096; // Context size
    ctx_params.n_threads = 4; // Use 4 CPU threads fallback
    
    impl_->ctx = llama_new_context_with_model(impl_->model, ctx_params);
    if (!impl_->ctx) {
        std::cerr << "[LocalLLMEngine] Failed to create context." << std::endl;
        llama_free_model(impl_->model);
        impl_->model = nullptr;
        return false;
    }

    // Initialize a batch for token generation
    impl_->batch = llama_batch_init(512, 0, 1);
    impl_->is_ready = true;
    
    std::cout << "[LocalLLMEngine] Successfully loaded model: " << modelPath << std::endl;
    return true;
#else
    std::cerr << "[LocalLLMEngine] Compiled without LLM support (OCR_ENABLE_LLM=OFF)." << std::endl;
    return false;
#endif
}

bool LocalLLMEngine::isReady() const {
    return impl_->is_ready;
}

std::string LocalLLMEngine::generateResponse(const std::string& prompt) {
#ifdef OCR_ENABLE_LLM
    if (!isReady()) return "";
    
    std::lock_guard<std::mutex> lock(impl_->inference_mutex);
    
    // (A highly simplified text generation loop using llama.cpp)
    // 1. Tokenize the prompt
    std::vector<llama_token> prompt_tokens(prompt.size() + 2);
    int n_tokens = llama_tokenize(
        impl_->model, prompt.c_str(), prompt.size(), 
        prompt_tokens.data(), prompt_tokens.size(), true, false
    );
    
    if (n_tokens < 0) {
        prompt_tokens.resize(-n_tokens);
        n_tokens = llama_tokenize(
            impl_->model, prompt.c_str(), prompt.size(), 
            prompt_tokens.data(), prompt_tokens.size(), true, false
        );
    }
    
    if (n_tokens < 0 || n_tokens > (int)prompt_tokens.size()) {
        std::cerr << "[LocalLLMEngine] Failed to tokenize prompt." << std::endl;
        return "";
    }
    
    // 2. Decode the prompt
    for (int i = 0; i < n_tokens; i++) {
        llama_batch_add(impl_->batch, prompt_tokens[i], i, {0}, false);
    }
    // Set the last token to output logits
    impl_->batch.logits[impl_->batch.n_tokens - 1] = true;
    
    if (llama_decode(impl_->ctx, impl_->batch) != 0) {
        std::cerr << "[LocalLLMEngine] llama_decode failed." << std::endl;
        return "";
    }
    
    // 3. Generate response loop
    std::string result = "";
    int n_cur = impl_->batch.n_tokens;
    const int n_max_tokens = 1024;
    
    while (n_cur <= n_max_tokens) {
        // Sample the next token
        auto* logits = llama_get_logits_ith(impl_->ctx, impl_->batch.n_tokens - 1);
        const int n_vocab = llama_n_vocab(impl_->model);
        
        // Greedy sampling for simplicity (choose max logit)
        llama_token new_token_id = 0;
        float max_logit = -1e9;
        for (int i = 0; i < n_vocab; i++) {
            if (logits[i] > max_logit) {
                max_logit = logits[i];
                new_token_id = i;
            }
        }
        
        // Check for EOS
        if (new_token_id == llama_token_eos(impl_->model)) {
            break;
        }
        
        // Convert token to string
        char buf[128];
        int n_chars = llama_token_to_piece(impl_->model, new_token_id, buf, sizeof(buf), 0, false);
        if (n_chars > 0) {
            result += std::string(buf, n_chars);
        }
        
        // Prepare next decode
        llama_batch_clear(impl_->batch);
        llama_batch_add(impl_->batch, new_token_id, n_cur, {0}, true);
        
        if (llama_decode(impl_->ctx, impl_->batch) != 0) {
            break;
        }
        n_cur++;
    }
    
    return result;
#else
    return "[LLM Disabled in Build]";
#endif
}

std::string LocalLLMEngine::fixOcrText(const std::string& brokenText) {
    std::string prompt = "<|im_start|>system\n"
                         "You are an AI assistant that fixes OCR errors. Fix typos, spacing, and broken paragraphs. "
                         "Return ONLY the corrected text, no conversational filler.\n"
                         "<|im_end|>\n"
                         "<|im_start|>user\n" + brokenText + "<|im_end|>\n"
                         "<|im_start|>assistant\n";
    return generateResponse(prompt);
}

std::string LocalLLMEngine::translate(const std::string& text, const std::string& targetLanguage) {
    std::string prompt = "<|im_start|>system\n"
                         "You are a professional translator. Translate the given text to " + targetLanguage + ". "
                         "Return ONLY the translation, no conversational filler.\n"
                         "<|im_end|>\n"
                         "<|im_start|>user\n" + text + "<|im_end|>\n"
                         "<|im_start|>assistant\n";
    return generateResponse(prompt);
}

std::string LocalLLMEngine::extractEntities(const std::string& text) {
    std::string prompt = "<|im_start|>system\n"
                         "Extract structured data from the text and output strictly as JSON. "
                         "Find Names, Dates, Amounts, and Companies if present.\n"
                         "<|im_end|>\n"
                         "<|im_start|>user\n" + text + "<|im_end|>\n"
                         "<|im_start|>assistant\n";
    return generateResponse(prompt);
}

} // namespace ocr
